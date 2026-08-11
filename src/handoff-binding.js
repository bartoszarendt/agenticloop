/**
 * Target-owned wiring for the pure handoff-recognition seam.
 *
 * `handoff-recognition.js` decides; this module supplies what that decision
 * needs from the target: the operator-owned capability inventory, the activation
 * binding resolver, and the effective assurance policy. Both halves of the seam
 * use the same canonical dispatch validator here - a prepared dispatch is
 * validated directly, and a verified return has the packet it consumed
 * revalidated the same way - so neither half can be satisfied by an artifact
 * that merely digests to itself.
 *
 * Entering `in-progress` is the role start on files and on GitHub alike, so that
 * decision lives here once rather than being restated per carrier. Every
 * expectation is assembled from durable state and current operator policy;
 * nothing is read back out of the artifact under judgement.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { activationCapabilityInventory, validateDispatchPreparation } from './dispatch-envelope.js';
import { loadHostTrustStore, targetRepositoryIdentity } from './host-trust.js';
import { resolveEffectiveActivationPolicy, resolvePacketActivationBinding } from './activation-resolution.js';
import {
  HANDOFF_RETURN_MAX_AGE_SECONDS,
  createPreparedDispatchValidation,
  recognizeHandoff,
  recognizeStoredReturnHandoff,
} from './handoff-recognition.js';
import { VerificationContextMalformedError } from './public-error.js';
import { revalidateReturnVerification } from './return-verification.js';
import { currentDispatchConsumption } from './handoff-consumption.js';

/**
 * Read the operator-owned capability inventory for packet validation.
 *
 * An unreadable or unsupported trust boundary is not permission: it surfaces as
 * a validator failure, so the packet is refused rather than accepted on the
 * strength of its own digest.
 */
function packetCapabilities(target, io, assertedPath) {
  const store = loadHostTrustStore(target, {
    operatorTrustRoot: io?.operatorTrustRoot ?? undefined,
    assertedPath,
    protectedBoundary: io?.hostAuthority ?? undefined,
  });
  if (store.state === 'unsupported_boundary') {
    throw new Error(`Host trust registry declares dynamic supported adapters: ${store.errors.join('; ')}`);
  }
  if (!store.ok) throw new Error(`Host trust store is invalid: ${store.errors.join('; ')}`);
  return activationCapabilityInventory(store.adapters);
}

/**
 * The trusted in-process dispatch evaluator, bound to one target's
 * operator-owned trust. Its returned digest is packet/result integrity, not
 * validator authentication. Authority comes from public command/binding
 * callers rerunning this complete evaluator immediately before mutation.
 *
 * A packet digest that matches its own projection proves internal consistency
 * and nothing more - the helper that computes it is exported, so an agent can
 * recompute it for a packet it invented. This is what actually checks the
 * activation authority, decomposition source, and capability declarations
 * behind the packet, and an unreadable or unsupported trust boundary surfaces
 * as a validation failure rather than as permission.
 *
 * @param {{target: string, io: any, hostTrustStore?: string|undefined}} context
 * @returns {(packet: any) => {ok: boolean, errors: string[]}}
 */
export function canonicalDispatchValidator({ target, io, hostTrustStore = undefined }) {
  return packet => {
    try {
      const checked = validateDispatchPreparation(packet, {
        capabilities: packetCapabilities(target, io, hostTrustStore),
        resolveActivationBinding: value => resolvePacketActivationBinding(target, io, value, {
          hostTrustStorePath: hostTrustStore,
        }),
      });
      return createPreparedDispatchValidation(packet, { ok: checked.ok, errors: checked.errors });
    } catch (error) {
      return createPreparedDispatchValidation(packet, {
        ok: false, errors: [`dispatch packet could not be validated: ${error.message}`],
      });
    }
  };
}

/**
 * Recognize one role start.
 *
 * @param {{
 *   target: string,
 *   io: any,
 *   backend: 'files'|'github',
 *   taskId: string|null,
 *   taskContractDigest: string|null,
 *   dispatchCarrierDigest: string|null,
 *   packetPath: string|null,
 *   hostTrustStore?: string|undefined,
 *   validatePreparedDispatch?: ((packet: any) => {ok: boolean, errors?: string[]})|null,
 *   consumedPacketIds?: string[],
 *   rawStartLabel: string,
 * }} input
 * @returns {object} frozen closed recognition verdict
 */
export function recognizeRoleStart({
  target,
  io,
  backend,
  taskId,
  taskContractDigest,
  dispatchCarrierDigest,
  packetPath,
  hostTrustStore = undefined,
  validatePreparedDispatch: suppliedValidator = null,
  consumedPacketIds = [],
  rawStartLabel,
}) {
  let suppliedPacket = null;
  if (packetPath) {
    try {
      suppliedPacket = JSON.parse(readFileSync(resolve(target, String(packetPath)), 'utf8'));
    } catch (error) {
      throw new VerificationContextMalformedError(
        `dispatch packet is unreadable or is not JSON: ${error.message}`
      );
    }
  }
  let policy = null;
  try {
    policy = resolveEffectiveActivationPolicy(target, io);
  } catch {
    // Unresolvable operator policy is not permission. The expectation stays
    // incomplete and recognition refuses with a typed expectation diagnostic
    // rather than inventing a minimum the operator never pinned.
  }
  const validatePreparedDispatch = suppliedPacket === null
    ? null
    : suppliedValidator ?? canonicalDispatchValidator({ target, io, hostTrustStore });
  return recognizeHandoff({
    transition: 'role_start',
    expectation: {
      backend,
      taskId,
      roleId: 'engineer',
      taskContractDigest,
      dispatchCarrierDigest,
      minimumActivationAssurance: policy?.minimumActivation ?? null,
      minimumReturnAssurance: policy?.minimumReturn ?? null,
    },
    preparedDispatch: suppliedPacket,
    validatePreparedDispatch,
    consumedPacketIds,
    observations: suppliedPacket === null ? [{ label: rawStartLabel }] : [],
  });
}

/**
 * Recognize a stored Engineer return for a protected post-role transition.
 * The caller supplies live carrier and repository refetches; trust, assurance,
 * repository identity, age, packet validation, and canonical return replay are
 * owned here once for files and GitHub.
 */
export function recognizeLifecycleReturn({
  target,
  io,
  transition,
  backend,
  taskId,
  taskContractDigest,
  currentCarrierDigest,
  productHead = null,
  artifactPr = null,
  workUnitIdentity = null,
  refetchTask,
  refetchRepositoryEvidence,
  hostTrustStore = undefined,
}) {
  const consumed = currentDispatchConsumption(target, taskId, { backend });
  if (!consumed.ok || !consumed.record) {
    return recognizeHandoff({
      transition,
      expectation: {
        backend, taskId, roleId: 'engineer', taskContractDigest,
         minimumReturnAssurance: 'session_reported',
      },
      observations: [{
        label: consumed.errors?.[0] ?? 'no durable canonical dispatch consumption exists for this task',
      }],
    });
  }
  const dispatch = consumed.record;
  let policy = null;
  let adapters = {};
  let trustErrors = [];
  try {
    policy = resolveEffectiveActivationPolicy(target, io);
    const store = loadHostTrustStore(target, {
      operatorTrustRoot: io?.operatorTrustRoot ?? undefined,
      assertedPath: hostTrustStore,
      protectedBoundary: io?.hostAuthority ?? undefined,
    });
    if (!store.ok) trustErrors = store.errors;
    else adapters = store.adapters;
  } catch (error) {
    trustErrors = [error.message];
  }
  const validateVerifiedReturn = record => {
    if (trustErrors.length > 0) {
      return { ok: false, errors: trustErrors, evidenceState: 'malformed' };
    }
    if (artifactPr !== null && (
      Number(record?.evidence?.roleReturn?.pr?.number) !== artifactPr ||
      Number(record?.evidence?.repositoryEvidence?.pr?.number) !== artifactPr
    )) {
      return {
        ok: false,
        errors: [`verified return does not bind integration PR #${artifactPr}`],
        evidenceState: 'stale',
      };
    }
    return revalidateReturnVerification(record, {
      target,
      capabilities: activationCapabilityInventory(adapters),
      resolveActivationBinding: packet => resolvePacketActivationBinding(target, io, packet, {
        hostTrustStorePath: hostTrustStore,
      }),
      resolveTrustedAdapter: adapterId => {
        const adapter = adapters[adapterId];
        if (!adapter) throw new Error(`return adapter '${adapterId}' is not currently trusted through the protected boundary`);
        return adapter;
      },
      expectedBackend: backend,
      expectedTaskId: taskId,
       expectedTaskContractDigest: taskContractDigest,
      expectedWorkUnitIdentity: dispatch.workUnitIdentity ?? workUnitIdentity,
      refetchTask,
      refetchRepositoryEvidence: () => refetchRepositoryEvidence(record),
      runGit: args => spawnSync('git', args, { cwd: target, encoding: 'utf8' }),
      minimumReturnAssurance: policy?.minimumReturn ?? null,
    });
  };
  return recognizeStoredReturnHandoff({
    target,
    transition,
    validatePreparedDispatch: canonicalDispatchValidator({ target, io, hostTrustStore }),
    validateVerifiedReturn,
    maxEvidenceAgeSeconds: HANDOFF_RETURN_MAX_AGE_SECONDS,
    expectation: {
      backend,
      taskId,
      roleId: 'engineer',
      taskContractDigest,
       dispatchCarrierDigest: dispatch.dispatchCarrierDigest,
       currentCarrierDigest,
       invocationId: dispatch.invocationId,
      packetId: dispatch.packetId,
      packetDigest: dispatch.packetDigest,
       productBaseHead: dispatch.productBaseHead,
       productHead,
      workUnitIdentity: dispatch.workUnitIdentity ?? workUnitIdentity,
      worktreeRoot: dispatch.worktreeRoot ?? resolve(target),
      repositoryIdentity: dispatch.repositoryIdentity ?? targetRepositoryIdentity(target),
      minimumReturnAssurance: policy?.minimumReturn ?? null,
    },
  });
}
