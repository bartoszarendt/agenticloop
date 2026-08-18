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

import { GIT_MAX_BUFFER } from './git-runner.js';
import { activationCapabilityInventory, validateDispatchPreparation } from './dispatch-envelope.js';
import { createExecutionReceiptReplayAuthority, loadHostTrustStore, targetRepositoryIdentity } from './host-trust.js';
import { resolveEffectiveActivationPolicy, resolvePacketActivationBinding } from './activation-resolution.js';
import {
  createPreparedDispatchValidation,
  recognizeHandoff,
  recognizeStoredReturnHandoff,
} from './handoff-recognition.js';
import { RETURN_USE_FRESHNESS_POLICY } from './return-use-freshness.js';
import { resolveReturnUseFreshnessPolicy } from './return-use-freshness.js';
import { loadProjectMap } from './project-map.js';
import { VerificationContextMalformedError } from './public-error.js';
import {
  CURRENT_REQUIRED_CHECK_EVIDENCE_ASSURANCE,
  revalidateReturnVerification,
} from './return-verification.js';
import { currentDispatchConsumption, resolveCarrierLineage } from './handoff-consumption.js';

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
export function canonicalDispatchValidator({
  target, io, hostTrustStore = undefined,
  // Optional: the instant this packet's activation authority is judged at. A
  // boundary revalidating an already-consumed attempt supplies the consumption
  // instant, because expiry is not retroactive for work it already authorized
  // (C12-F9). Boundaries that authorize *new* work leave it absent and get the
  // current clock.
  activationInstantFor = null,
}) {
  return packet => {
    try {
      const now = typeof activationInstantFor === 'function' ? activationInstantFor(packet) : null;
      const checked = validateDispatchPreparation(packet, {
        capabilities: packetCapabilities(target, io, hostTrustStore),
        resolveActivationBinding: value => resolvePacketActivationBinding(target, io, value, {
          hostTrustStorePath: hostTrustStore,
          ...(typeof now === 'number' && Number.isFinite(now) ? { now } : {}),
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
  const returnUse = resolveReturnUseFreshnessPolicy(loadProjectMap(target)?.raw ?? {});
  if (!returnUse.ok) {
    return recognizeHandoff({ transition, expectation: { backend, taskId, roleId: 'engineer', taskContractDigest, minimumReturnAssurance: null }, observations: [{ label: `return-use freshness configuration is invalid: ${returnUse.errors.join('; ')}` }] });
  }
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
  // Expiry is not retroactive (C12-F9). Every transition reached here acts on an
  // attempt that was already consumed, so the authority that authorized it is
  // judged as of that consumption instant rather than the current clock -
  // exactly as terminal closeout already does. A 12-hour grant whose window
  // closes during review must not block acceptance of work it genuinely
  // authorized. Pinning only narrows: a grant issued after the attempt started
  // still fails, and revocation is matched by grant identity and stays
  // time-independent.
  const consumedAtMs = Date.parse(dispatch.consumedAt);
  const activationEvaluatedAt = Number.isFinite(consumedAtMs) && consumedAtMs <= Date.now() ? consumedAtMs : null;
  const pinnedActivationOptions = activationEvaluatedAt === null ? {} : { now: activationEvaluatedAt };
  // Acceptance is the first transition after the return, and its own gate
  // requires post-return Maintainer review provenance on the carrier
  // (`review_status`, `review_mode`, `reviewed_artifact`, `## Scope Completed`,
  // `## Evidence`). The live carrier therefore cannot still equal the carrier
  // the Engineer returned, and demanding that equality made acceptance
  // unreachable through the canonical chain (P35-C12R.5 layer 3).
  //
  // The expectation is replaced, not dropped: the verified return must describe
  // the durably recognized Engineer return terminal. That digest is resolved
  // from the dispatch consumption and the Engineer receipt chain, so no caller
  // may substitute a convenient value, and a return from another carrier
  // generation is still refused. The live carrier keeps its own authority - the
  // `--expect-digest` gate and the atomic write that performs the transition.
  let returnTerminal = null;
  if (transition === 'acceptance') {
    const lineage = resolveCarrierLineage(target, taskId, {
      backend, taskContractDigest, boundary: 'engineer_return',
    });
    if (!lineage.ok) {
      return recognizeHandoff({
        transition,
        expectation: {
          backend, taskId, roleId: 'engineer', taskContractDigest,
          minimumReturnAssurance: 'session_reported',
        },
        observations: lineage.errors.map(label => ({ label })),
      });
    }
    returnTerminal = lineage.currentCarrierDigest;
  }
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
        ...pinnedActivationOptions,
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
      runGit: args => spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER }),
      minimumReturnAssurance: policy?.minimumReturn ?? null,
      // Standard evidence is usable only when the independently resolved
      // current policy explicitly selects standard mode.  Backend is transport,
      // not a policy or an assurance grant.
      minimumRequiredCheckEvidenceAssurance: policy?.mode === 'standard'
        ? CURRENT_REQUIRED_CHECK_EVIDENCE_ASSURANCE
        : 'authenticated_receipt',
      executionReceiptReplayAuthority: createExecutionReceiptReplayAuthority({
        target,
        trustedAdapter: adapters[record.producerAuthentication?.adapterId],
        protectedBoundary: io?.hostAuthority,
      }),
    });
  };
  return recognizeStoredReturnHandoff({
    target,
    transition,
    validatePreparedDispatch: canonicalDispatchValidator({
      target, io, hostTrustStore,
      activationInstantFor: () => activationEvaluatedAt,
    }),
    returnVerificationContext: {
      resolveTrustedAdapter: adapterId => {
        const adapter = adapters[adapterId];
        if (!adapter) throw new Error(`return adapter '${adapterId}' is not currently trusted through the protected boundary`);
        return adapter;
      },
      resolveExecutionReceiptReplayAuthority: record => createExecutionReceiptReplayAuthority({
        target,
        trustedAdapter: adapters[record.producerAuthentication?.adapterId],
        protectedBoundary: io?.hostAuthority,
      }),
    },
    validateVerifiedReturn,
    maxEvidenceAgeSeconds: returnUse.policy.maxAgeSeconds,
    expectation: {
      backend,
      taskId,
      roleId: 'engineer',
      taskContractDigest,
       dispatchCarrierDigest: dispatch.dispatchCarrierDigest,
       currentCarrierDigest: transition === 'integration' || transition === 'closeout'
         ? null
         : transition === 'acceptance' ? returnTerminal : currentCarrierDigest,
       invocationId: dispatch.invocationId,
      packetId: dispatch.packetId,
      packetDigest: dispatch.packetDigest,
       productBaseHead: dispatch.productBaseHead,
       productHead,
      workUnitIdentity: dispatch.workUnitIdentity ?? workUnitIdentity,
      worktreeRoot: dispatch.worktreeRoot ?? resolve(target),
      repositoryIdentity: dispatch.repositoryIdentity ?? targetRepositoryIdentity(target),
      minimumReturnAssurance: policy?.minimumReturn ?? null,
      returnUseFreshnessPolicy: returnUse.policy,
    },
  });
}
