/** Durable proof that a canonical dispatch packet was consumed at role start. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalSha256 } from './canonical-json.js';
import { GIT_OBJECT_ID_RE } from './git-oid.js';
import { validateHandoffRecognition } from './handoff-recognition.js';
import { executeMutationBatch } from './fs-mutation-kernel.js';
import { ENGINEER_CARRIER_MUTATION_CLASSES, validateCarrierMutationReceipt } from './task-evidence-contract.js';
import { classifyLifecycleCompatibility, compatibilityMessage } from './lifecycle-compatibility.js';

export const DISPATCH_CONSUMPTION_KIND = 'agenticloop.dispatch-consumption';
export const DISPATCH_CONSUMPTION_SCHEMA_VERSION = 3;
export const DISPATCH_CONSUMPTION_CLOCK_SKEW_MS = 1000;
export const TASK_CARRIER_MUTATION_ROOT = '.agenticloop/handoffs/task-mutations';

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PACKET_ID_RE = /^dispatch:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMANTIC_DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;
const TASK_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function dispatchConsumptionDigest(record) {
  const projection = { ...record };
  delete projection.digest;
  return `sha256:agenticloop.dispatch-consumption.v${DISPATCH_CONSUMPTION_SCHEMA_VERSION}:${canonicalSha256(projection)}`;
}

export function createDispatchConsumption({
  backend, taskId, recognition, currentCarrierDigest, consumedAt = new Date().toISOString(),
}) {
  const checked = validateHandoffRecognition(recognition);
  if (!checked.ok || recognition?.recognized !== true || recognition.transition !== 'role_start' ||
      recognition.requirement !== 'prepared_dispatch') {
    throw new TypeError('dispatch consumption requires a valid recognized prepared-dispatch role-start verdict');
  }
  const identity = recognition.boundIdentity;
  const record = {
    kind: DISPATCH_CONSUMPTION_KIND,
    schemaVersion: DISPATCH_CONSUMPTION_SCHEMA_VERSION,
    backend,
    taskId,
    packetId: identity.packetId,
    packetDigest: identity.packetDigest,
    invocationId: identity.invocationId,
    taskContractDigest: identity.taskContractDigest,
    dispatchCarrierDigest: identity.dispatchCarrierDigest,
    // At role start the sealed dispatch carrier is the current carrier unless
    // the caller observed a later authoritative carrier explicitly.
    currentCarrierDigest: currentCarrierDigest ?? identity.currentCarrierDigest ?? identity.dispatchCarrierDigest,
    workUnitIdentity: identity.workUnitIdentity,
    repositoryIdentity: identity.repositoryIdentity,
    worktreeRoot: identity.worktreeRoot,
    productBaseHead: identity.productBaseHead,
    mutationClass: 'role_start_status',
    workflowRole: identity.roleId,
    assuranceGrade: recognition.observedGrade,
    recognitionDigest: recognition.digest,
    recognition,
    consumedAt,
    digest: null,
  };
  record.digest = dispatchConsumptionDigest(record);
  const validation = validateDispatchConsumption(record, { backend, taskId });
  if (!validation.ok) throw new TypeError(`invalid dispatch consumption: ${validation.errors.join('; ')}`);
  return Object.freeze(record);
}

export function dispatchConsumptionRelativePath(record) {
  return `.agenticloop/handoffs/dispatch/${safeSegment(record.taskId)}/${safeSegment(record.packetId)}.json`;
}

export function validateDispatchConsumption(record, {
  backend = null, taskId = null, filename = null, now = Date.now(),
} = {}) {
  const required = [
    'kind', 'schemaVersion', 'backend', 'taskId', 'packetId', 'packetDigest', 'invocationId',
    'taskContractDigest', 'dispatchCarrierDigest', 'currentCarrierDigest', 'workUnitIdentity', 'repositoryIdentity',
    'worktreeRoot', 'productBaseHead', 'mutationClass', 'workflowRole', 'assuranceGrade',
    'recognitionDigest', 'recognition', 'consumedAt', 'digest',
  ];
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== required.length ||
      Object.keys(record).some(key => !required.includes(key))) {
    return { ok: false, errors: ['dispatch consumption fields must equal the closed schema'] };
  }
  if (record.kind !== DISPATCH_CONSUMPTION_KIND) errors.push(`dispatch consumption kind must be '${DISPATCH_CONSUMPTION_KIND}'`);
  if (record.schemaVersion !== DISPATCH_CONSUMPTION_SCHEMA_VERSION) errors.push(`dispatch consumption schemaVersion must be ${DISPATCH_CONSUMPTION_SCHEMA_VERSION}`);
  if (!['files', 'github'].includes(record.backend)) errors.push('dispatch consumption backend is invalid');
  if (backend !== null && record.backend !== backend) errors.push(`dispatch consumption backend '${record.backend}' does not match expected backend '${backend}'`);
  if (typeof record.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.taskId)) errors.push('dispatch consumption taskId is invalid');
  if (taskId !== null && record.taskId !== taskId) errors.push(`dispatch consumption taskId '${record.taskId}' does not match expected task '${taskId}'`);
  if (!PACKET_ID_RE.test(String(record.packetId ?? ''))) errors.push('dispatch consumption packetId is invalid');
  if (!SEMANTIC_DIGEST_RE.test(String(record.packetDigest ?? ''))) errors.push('dispatch consumption packetDigest is invalid');
  if (typeof record.invocationId !== 'string' || !record.invocationId) errors.push('dispatch consumption invocationId is invalid');
  if (!CONTRACT_DIGEST_RE.test(String(record.taskContractDigest ?? ''))) errors.push('dispatch consumption taskContractDigest is invalid');
  if (!TASK_DIGEST_RE.test(String(record.dispatchCarrierDigest ?? ''))) errors.push('dispatch consumption dispatchCarrierDigest is invalid');
  if (!TASK_DIGEST_RE.test(String(record.currentCarrierDigest ?? ''))) errors.push('dispatch consumption currentCarrierDigest is invalid');
  if (typeof record.workUnitIdentity !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/.test(record.workUnitIdentity)) errors.push('dispatch consumption workUnitIdentity is invalid');
  if (typeof record.repositoryIdentity !== 'string' || !record.repositoryIdentity) errors.push('dispatch consumption repositoryIdentity is invalid');
  if (typeof record.worktreeRoot !== 'string' || !record.worktreeRoot) errors.push('dispatch consumption worktreeRoot is invalid');
  if (!GIT_OBJECT_ID_RE.test(String(record.productBaseHead ?? ''))) errors.push('dispatch consumption productBaseHead is invalid');
  if (record.mutationClass !== 'role_start_status') errors.push("dispatch consumption mutationClass must be 'role_start_status'");
  if (record.workflowRole !== 'engineer') errors.push("dispatch consumption workflowRole must be immutable 'engineer'");
  if (!['operator_confirmed', 'host_signed'].includes(record.assuranceGrade)) errors.push('dispatch consumption assuranceGrade is invalid');
  if (!SEMANTIC_DIGEST_RE.test(String(record.recognitionDigest ?? ''))) errors.push('dispatch consumption recognitionDigest is invalid');

  const recognition = validateHandoffRecognition(record.recognition);
  if (!recognition.ok) errors.push(...recognition.errors.map(error => `embedded recognition: ${error}`));
  else {
    if (record.recognition.recognized !== true || record.recognition.transition !== 'role_start' ||
        record.recognition.requirement !== 'prepared_dispatch') {
      errors.push('embedded recognition must be a recognized prepared-dispatch role-start verdict');
    }
    if (record.recognitionDigest !== record.recognition.digest) errors.push('dispatch consumption recognitionDigest does not match embedded recognition');
    const identity = record.recognition.boundIdentity;
    for (const field of [
      'backend', 'taskId', 'packetId', 'packetDigest', 'invocationId', 'taskContractDigest', 'dispatchCarrierDigest',
      'workUnitIdentity', 'repositoryIdentity', 'worktreeRoot', 'productBaseHead',
    ]) {
      if (record[field] !== identity[field]) errors.push(`dispatch consumption ${field} does not match embedded recognition`);
    }
  }

  const consumedMs = Date.parse(record.consumedAt);
  if (!ISO_UTC_RE.test(String(record.consumedAt ?? '')) || !Number.isFinite(consumedMs)) {
    errors.push('dispatch consumption consumedAt must be a strict ISO-8601 UTC instant');
  } else if (consumedMs > now + DISPATCH_CONSUMPTION_CLOCK_SKEW_MS) {
    errors.push('dispatch consumption consumedAt is future-dated');
  }
  if (filename !== null && filename !== `${safeSegment(record.packetId)}.json`) {
    errors.push('dispatch consumption filename does not match its packet identity');
  }
  if (record.digest !== dispatchConsumptionDigest(record)) errors.push('dispatch consumption digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function listDispatchConsumptions(target, taskId, options = {}) {
  const directory = join(target, '.agenticloop', 'handoffs', 'dispatch', safeSegment(taskId));
  if (!existsSync(directory)) return { ok: true, records: [], errors: [] };
  const records = [];
  const errors = [];
  for (const name of readdirSync(directory).filter(value => value.endsWith('.json')).sort()) {
    try {
      const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const compatibility = classifyLifecycleCompatibility(record, DISPATCH_CONSUMPTION_KIND);
      if (compatibility.state !== 'current') {
        errors.push(`${name}: ${compatibilityMessage(compatibility, 'dispatch consumption')}`);
      } else {
        const checked = validateDispatchConsumption(record, { ...options, taskId, filename: name });
        if (!checked.ok) errors.push(...checked.errors.map(error => `${name}: ${error}`));
        else records.push(record);
      }
    } catch (error) {
      errors.push(`${name}: dispatch consumption is unreadable: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, records, errors };
}

export function currentDispatchConsumption(target, taskId, options = {}) {
  const listed = listDispatchConsumptions(target, taskId, options);
  if (!listed.ok || listed.records.length === 0) return { ...listed, record: null };
  const ordered = [...listed.records].sort((a, b) =>
    Date.parse(a.consumedAt) - Date.parse(b.consumedAt) || a.packetId.localeCompare(b.packetId));
  return { ok: true, records: listed.records, errors: [], record: ordered.at(-1) };
}

export function carrierMutationRelativePath(receipt) {
  return `${TASK_CARRIER_MUTATION_ROOT}/${safeSegment(receipt.task.id)}/${safeSegment(receipt.receiptId)}.json`;
}

export function writeCarrierMutationReceipt(target, receipt) {
  const checked = validateCarrierMutationReceipt(receipt);
  if (!checked.ok) return { ok: false, errors: checked.errors, path: null };
  const path = carrierMutationRelativePath(receipt);
  const applied = executeMutationBatch(target, [{
    type: 'create', path, content: `${JSON.stringify(receipt, null, 2)}\n`,
  }]);
  return {
    ok: applied.ok,
    errors: [...applied.errors, ...applied.rollbackErrors],
    path,
    disposition: applied.ok ? 'created' : 'conflict',
  };
}

export function listCarrierMutationReceipts(target, taskId, { backend = null } = {}) {
  const directory = join(target, TASK_CARRIER_MUTATION_ROOT, safeSegment(taskId));
  if (!existsSync(directory)) return { ok: true, records: [], errors: [] };
  const records = [];
  const errors = [];
  for (const name of readdirSync(directory).filter(value => value.endsWith('.json')).sort()) {
    try {
      const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const compatibility = classifyLifecycleCompatibility(record, 'agenticloop.task-mutation-receipt');
      if (compatibility.state !== 'current') {
        errors.push(`${name}: ${compatibilityMessage(compatibility, 'carrier mutation receipt')}`);
      } else {
        const checked = validateCarrierMutationReceipt(record);
        if (!checked.ok) errors.push(`${name}: ${checked.errors.join('; ')}`);
        else if (record.task.id !== taskId || (backend !== null && record.backend !== backend)) {
          errors.push(`${name}: carrier mutation receipt identity does not match its storage task/backend`);
        } else if (name !== `${safeSegment(record.receiptId)}.json`) {
          errors.push(`${name}: carrier mutation receipt filename does not match its identity`);
        } else records.push(record);
      }
    } catch (error) {
      errors.push(`${name}: carrier mutation receipt is unreadable: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, records, errors };
}

/**
 * The two carrier boundaries one task generation has.
 *
 * `engineer_return` is the execution boundary: the chain the Engineer built
 * during its own attempt, terminating at the carrier the signed return
 * describes. `lifecycle` is the broader boundary that continues past the
 * authenticated return through role-owned lifecycle transitions (today the
 * guarded GitHub `acceptance_transition`), terminating at the live carrier.
 *
 * They are not the same digest and must not be conflated: P35-C12R.5 measured
 * exactly one failure mode from doing so - extending the Engineer chain with a
 * post-return acceptance receipt moves its terminal off the carrier the
 * verified return names, and every return refetch then reports a terminal
 * mismatch. Callers therefore name the boundary they are asking about.
 */
export const CARRIER_LINEAGE_BOUNDARIES = Object.freeze(['engineer_return', 'lifecycle']);

/**
 * Verify the one ordered mutable-carrier lineage accepted during an Engineer
 * run. No current task body can substitute for a missing edge.
 *
 * @param {string} target
 * @param {string} taskId
 * @param {object} options
 * @param {'engineer_return'|'lifecycle'} [options.boundary]  Which terminal is
 *   being asked for. `engineer_return` refuses to absorb a lifecycle-owned
 *   mutation into the Engineer chain; `lifecycle` accepts the full vocabulary.
 */
export function resolveCarrierLineage(target, taskId, {
  backend, taskContractDigest, currentCarrierDigest, boundary = 'lifecycle',
} = {}) {
  if (!CARRIER_LINEAGE_BOUNDARIES.includes(boundary)) {
    return { ok: false, errors: [`carrier lineage boundary '${boundary}' is not recognized`], records: [] };
  }
  const consumed = currentDispatchConsumption(target, taskId, { backend });
  if (!consumed.ok || !consumed.record) {
    return { ok: false, errors: consumed.errors?.length ? consumed.errors : ['no recognized dispatch consumption exists'], records: [] };
  }
  const start = consumed.record;
  const listed = listCarrierMutationReceipts(target, taskId, { backend });
  if (!listed.ok) return { ok: false, errors: listed.errors, records: [] };
  const errors = [];
  if (taskContractDigest !== undefined && start.taskContractDigest !== taskContractDigest) errors.push('dispatch consumption taskContractDigest does not match current task contract');
  let predecessorDigest = start.digest;
  let carrierDigest = start.currentCarrierDigest;
  const records = [];
  // Receipts from a completed/revised dispatch generation share a task
  // directory but are not predecessor candidates for this dispatch. Scope the
  // chain by the complete immutable dispatch tuple before looking for edges.
  const isGenerationReceipt = receipt =>
    receipt.taskContractDigest === start.taskContractDigest &&
    receipt.dispatchCarrierDigest === start.dispatchCarrierDigest &&
    receipt.producer.invocationId === start.invocationId &&
    receipt.producer.workUnitIdentity === start.workUnitIdentity &&
    receipt.producer.repositoryIdentity === start.repositoryIdentity;
  // An Engineer return terminates where the Engineer stopped. A lifecycle-owned
  // mutation of the same generation is a real record, but it belongs to the
  // later boundary: absorbing it here would move the return terminal onto a
  // carrier the Engineer never authored and never signed for. It is excluded
  // from the chain, never used to bridge one: a lifecycle receipt standing
  // between two Engineer receipts still leaves the Engineer chain interrupted,
  // and that fails closed below.
  const remaining = listed.records.filter(receipt => isGenerationReceipt(receipt) &&
    (boundary !== 'engineer_return' || ENGINEER_CARRIER_MUTATION_CLASSES.includes(receipt.mutationClass)));
  // A receipt that reuses this dispatch carrier, or chains itself onto this
  // generation's consumption or onto any of its receipts, is an attempted
  // member of the generation even if one of its other bindings is forged. It
  // must fail here, not disappear as an unrelated historical record.
  const generationDigests = new Set([start.digest, ...listed.records.filter(isGenerationReceipt).map(item => item.digest)]);
  for (const receipt of listed.records.filter(receipt =>
    (receipt.dispatchCarrierDigest === start.dispatchCarrierDigest || generationDigests.has(receipt.predecessor.digest)) &&
    !isGenerationReceipt(receipt)
  )) {
    errors.push(`carrier mutation receipt '${receipt.receiptId}' claims the active dispatch generation with mismatched identity`);
  }
  while (remaining.length > 0) {
    const matches = remaining.filter(receipt => receipt.predecessor.digest === predecessorDigest);
    if (matches.length !== 1) {
      errors.push(matches.length === 0
        ? 'carrier mutation receipts contain an orphaned or interrupted predecessor chain'
        : 'carrier mutation receipts fork from one predecessor');
      break;
    }
    const receipt = matches[0];
    remaining.splice(remaining.indexOf(receipt), 1);
    if (receipt.taskContractDigest !== start.taskContractDigest ||
        receipt.dispatchCarrierDigest !== start.dispatchCarrierDigest ||
        receipt.priorCarrierDigest !== carrierDigest ||
        receipt.predecessor.digest !== predecessorDigest ||
        receipt.predecessor.kind !== (predecessorDigest === start.digest ? 'dispatch_consumption' : 'task_mutation_receipt') ||
        receipt.producer.invocationId !== start.invocationId ||
        receipt.producer.workUnitIdentity !== start.workUnitIdentity ||
        receipt.producer.repositoryIdentity !== start.repositoryIdentity) {
      errors.push(`carrier mutation receipt '${receipt.receiptId}' does not continue the recognized carrier lineage`);
      break;
    }
    records.push(receipt);
    predecessorDigest = receipt.digest;
    carrierDigest = receipt.currentCarrierDigest;
  }
  if (currentCarrierDigest !== undefined && carrierDigest !== currentCarrierDigest) errors.push('carrier lineage terminal currentCarrierDigest does not equal the current task carrier');
  return {
    ok: errors.length === 0,
    errors,
    dispatchConsumption: start,
    receipts: records,
    taskContractDigest: start.taskContractDigest,
    dispatchCarrierDigest: start.dispatchCarrierDigest,
    currentCarrierDigest: carrierDigest,
    productBaseHead: start.productBaseHead,
  };
}
