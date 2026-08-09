/**
 * Shared activation resolution for command surfaces.
 *
 * Both the activation CLI and dispatch preparation need the same three things:
 * the external operator confirmation key, the signature verifier built from it
 * (plus any operator-pinned host adapter key), and the durable grant/binding
 * records for one task. Keeping that in one module means the surface that
 * *creates* activation authority and the surface that *consumes* it can never
 * disagree about what counts.
 *
 * Nothing here reads authority from inside the target repository.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createActivationSignatureVerifier,
  loadOperatorActivationKey,
  readExternalActivationRevocations,
} from './activation-trust.js';
import { resolveTaskActivationBinding } from './activation-grant.js';
import { targetRepositoryIdentity } from './host-trust.js';
import { loadAgenticLoopConfig } from './json.js';
import {
  readActivationGrant,
  readActivationRevocations,
  readTaskActivationBinding,
} from './activation-store.js';
import { resolveActivationPolicy } from './activation-policy.js';
import { loadHostTrustStore } from './host-trust.js';
import {
  PublicCommandError,
  VerificationContextError,
  VerificationContextMalformedError,
} from './public-error.js';

/**
 * Resolve the operator activation key and the signature verifier for a target.
 *
 * A missing key is not an error here: a project that only uses legacy
 * host-signed captures never provisions one. It becomes an error at the point
 * where an unauthenticatable grant is actually presented.
 *
 * @param {string} target
 * @param {object} io
 * @param {{ hostTrustStorePath?: string }} [options]
 */
export function resolveActivationVerification(target, io, options = {}) {
  const operator = loadOperatorActivationKey(target, {
    operatorActivationRoot: io?.operatorActivationRoot ?? undefined,
  });
  if (!operator.ok) {
    throw new VerificationContextMalformedError(
      `Operator activation material is unusable: ${operator.errors.join('; ')}`
    );
  }
  // Host-signed grants verify against the same fixed operator trust store the
  // rest of the toolkit uses. Loading it is best effort: a project with no
  // pinned adapters simply cannot present a host-signed grant.
  let adapters = {};
  try {
    const store = loadHostTrustStore(target, {
      operatorTrustRoot: io?.operatorTrustRoot ?? undefined,
      assertedPath: options.hostTrustStorePath,
      protectedBoundary: io?.hostAuthority ?? undefined,
    });
    if (store.ok) adapters = store.adapters;
  } catch {
    adapters = {};
  }
  const verify = createActivationSignatureVerifier({
    operatorKey: operator.key,
    resolveHostAdapter: adapterId => adapters[adapterId] ?? null,
  });
  return { operatorKey: operator.key, operatorKeyState: operator.state, operatorKeyPath: operator.path, adapters, verify };
}

/**
 * Read the target's `agenticloop.json` for policy purposes only.
 *
 * An absent file is normal - a files-only project need not have one - and means
 * "no repository activation request". A present but unreadable file is a
 * typed malformed context, not a silent default.
 */
export function readTargetActivationConfig(target) {
  const path = join(target, 'agenticloop.json');
  if (!existsSync(path)) return {};
  try {
    return loadAgenticLoopConfig(path);
  } catch (error) {
    throw new VerificationContextMalformedError(`agenticloop.json is unreadable: ${error.message}`);
  }
}

/**
 * Resolve the effective activation/return assurance policy for a target.
 * A malformed operator pin or repository request fails closed at hardened.
 */
export function resolveEffectiveActivationPolicy(target, io, projectRawConfig) {
  const policy = resolveActivationPolicy({
    target,
    projectConfig: projectRawConfig ?? readTargetActivationConfig(target),
    operatorActivationRoot: io?.operatorActivationRoot ?? undefined,
  });
  if (!policy.ok) {
    throw new VerificationContextMalformedError(
      `Activation policy could not be resolved and fails closed at hardened: ${policy.errors.join('; ')}`
    );
  }
  return policy;
}

/**
 * Load the durable activation evidence bundle for one task, if any exists.
 *
 * Returns `null` when the task has no binding at all, so the caller can fall
 * back to legacy capture provenance or report the honest "not activated" state.
 *
 * @param {string} target
 * @param {{ backend: string, taskId: string }} task
 */
export function loadTaskActivationEvidence(target, { backend, taskId }) {
  const bindingRead = readTaskActivationBinding(target, backend, taskId);
  if (!bindingRead.ok) {
    throw new VerificationContextMalformedError(
      `Task activation binding for '${taskId}' is unreadable: ${bindingRead.errors.join('; ')}`
    );
  }
  if (bindingRead.state !== 'present') return null;
  const binding = bindingRead.record;
  const grantRead = readActivationGrant(target, binding?.grantId);
  if (!grantRead.ok) {
    throw new VerificationContextMalformedError(
      `Activation grant for task '${taskId}' is unreadable: ${grantRead.errors.join('; ')}`
    );
  }
  if (grantRead.state !== 'present') {
    throw new VerificationContextError(
      `Task '${taskId}' names activation grant '${String(binding?.grantId)}', which is not present in this repository`
    );
  }
  const revocations = readActivationRevocations(target);
  return {
    source: 'activation_grant',
    grant: grantRead.record,
    binding,
    // A malformed revocation record is carried through, not dropped: activation
    // resolution treats one as a revocation so a corrupted deny record cannot
    // silently re-enable a grant.
    revocations: revocations.revocations,
    revocationErrors: revocations.errors,
    bindingPath: bindingRead.path,
    grantPath: grantRead.path,
  };
}

function packetDecomposition(target, binding) {
  const sourceRef = binding?.decompositionSource?.sourceRef;
  if (binding?.derivation !== 'committed_decomposition_membership') return null;
  if (typeof sourceRef !== 'string' || !sourceRef) return null;
  const root = resolve(target);
  const path = resolve(root, sourceRef);
  if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Revalidate a packet-carried signed authority against current external deny and policy state. */
export function resolvePacketActivationBinding(target, io, packet, options = {}) {
  const envelope = packet?.activationBinding;
  if (!envelope?.grant || !envelope?.binding) {
    return { ok: false, evidenceState: 'missing', disposition: 'needs_context', errors: [{ message: 'grant-bound packet lacks its complete signed activation authority', evidenceState: 'missing', code: 'activation.grant.unauthenticated' }] };
  }
  let verification;
  let policy;
  try {
    verification = resolveActivationVerification(target, io, { hostTrustStorePath: options.hostTrustStorePath });
    policy = resolveEffectiveActivationPolicy(target, io);
  } catch (error) {
    return { ok: false, evidenceState: 'missing', disposition: 'blocked', errors: [{ message: error.message, evidenceState: 'missing', code: 'activation.grant.unauthenticated' }] };
  }
  const external = readExternalActivationRevocations(target, {
    operatorActivationRoot: io?.operatorActivationRoot ?? undefined,
  });
  if (!external.ok) {
    return { ok: false, evidenceState: 'malformed', disposition: 'blocked', errors: external.errors.map(message => ({ message, evidenceState: 'malformed', code: 'activation.grant.revoked' })) };
  }
  const local = readActivationRevocations(target);
  const resolved = resolveTaskActivationBinding({
    grant: envelope.grant,
    binding: envelope.binding,
    repositoryIdentity: targetRepositoryIdentity(target),
    backend: packet.backend,
    taskId: packet.task?.id,
    carrier: packet.task?.carrier,
    taskContractDigest: packet.task?.contractDigest,
    verifySignature: verification.verify,
    revocations: [...external.revocations, ...local.revocations],
    decomposition: packetDecomposition(target, envelope.binding),
    now: options.now,
  });
  if (resolved.ok && !policy.ok) return { ok: false, evidenceState: 'malformed', disposition: 'blocked', errors: [{ message: 'effective activation policy is unavailable', evidenceState: 'malformed', code: 'activation.policy.invalid' }] };
  if (resolved.ok && policy.minimumActivation === 'host_signed' && resolved.assurance !== 'host_signed') {
    return { ok: false, evidenceState: 'negative', disposition: 'blocked', errors: [{ message: `activation assurance '${resolved.assurance}' is below the effective minimum 'host_signed'`, evidenceState: 'negative', code: 'activation.assurance.insufficient' }] };
  }
  return resolved;
}

/**
 * Typed refusal for a task that carries neither activation model.
 *
 * The message is the whole point of the universal path: it names the exact
 * operator command that fixes it, and it is identical for every host.
 */
export function unactivatedTaskError(taskId) {
  return new PublicCommandError(
    `Task '${taskId}' has no activation authority: no legacy host-signed capture and no task activation binding.`,
    {
      code: 'activation.capture.missing',
      evidenceState: 'missing',
      disposition: 'needs_context',
      committedStateEvaluated: false,
      safeRepair:
        `Run 'npx agenticloop activate ${taskId}' in an interactive terminal outside the agent session, ` +
        'then continue in the same project. Never author activation JSON in model-visible text.',
      requiredContext: ['an operator-confirmed activation grant or a host-signed activation capture'],
    }
  );
}
