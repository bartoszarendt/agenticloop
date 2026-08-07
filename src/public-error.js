/** Typed facts carried from real producer sites to the public CLI boundary. */

import { dispositionForEvidenceState, evidenceStateRank, normalizeEvidenceState } from './result-envelope.js';

export const OPERATIONAL_FAILURE_MESSAGE =
  'The command could not complete because required operational context is unavailable.';

const FINDING_REPAIR = Object.freeze({
  'activation.capture.expired': 'Obtain a fresh supported host capture and create or dispatch a fresh activation-bound task as applicable; do not mutate or silently rebind the expired task.',
  'activation.capture.unsupported': 'Use a host integration with a resolved supported parser-owned capture capability; a scaffold or unsupported capture cannot dispatch.',
  'activation.capture.mismatch': 'Stop and obtain a new host capture for the exact authorized activation bytes.',
  'activation.capture.malformed': 'Repair or regenerate the malformed host capture, then rerun without changing task state.',
});

export class PublicCommandError extends Error {
  constructor(message, {
    code = 'cli.operational',
    evidenceState = 'missing',
    disposition = 'needs_context',
    safeRepair = null,
    committedStateEvaluated = false,
    publicMessage = message,
    requiredContext = [],
  } = {}) {
    super(message);
    this.name = 'PublicCommandError';
    this.code = code;
    this.evidenceState = evidenceState;
    this.disposition = disposition;
    this.safeRepair = safeRepair;
    this.committedStateEvaluated = committedStateEvaluated;
    this.publicMessage = String(publicMessage ?? OPERATIONAL_FAILURE_MESSAGE);
    this.requiredContext = [...new Set(
      (Array.isArray(requiredContext) ? requiredContext : [])
        .map(item => String(item ?? '').trim())
        .filter(Boolean)
    )];
  }
}

export class VerificationContextError extends PublicCommandError {
  constructor(message = 'Verification context is required before this evaluation can run.', options = {}) {
    super(message, {
      code: 'verification.context.missing',
      evidenceState: 'missing',
      disposition: 'needs_context',
      committedStateEvaluated: false,
      safeRepair: 'Supply the exact verification context; do not rollback or compensate based on this result.',
      requiredContext: ['the exact verification context required by the command'],
      ...options,
    });
    this.name = 'VerificationContextError';
  }
}

export class VerificationContextMalformedError extends PublicCommandError {
  constructor(message = 'Supplied verification context is malformed.', options = {}) {
    super(message, {
      code: 'verification.context.malformed',
      evidenceState: 'malformed',
      disposition: 'rejected',
      committedStateEvaluated: false,
      safeRepair: 'Repair or regenerate the verification context, then rerun without changing committed state.',
      requiredContext: ['well-formed verification context for the requested evaluation'],
      ...options,
    });
    this.name = 'VerificationContextMalformedError';
  }
}

export class VerificationContextUnsupportedBoundaryError extends PublicCommandError {
  constructor(message = 'Supplied verification context declares a capability the current boundary does not support.', options = {}) {
    super(message, {
      code: 'host.boundary.unsupported',
      evidenceState: 'negative',
      disposition: 'blocked',
      committedStateEvaluated: false,
      safeRepair: 'Remove the dynamic supported registry entry; a future supported adapter requires an authenticated out-of-process host boundary.',
      requiredContext: ['a host trust registry without dynamic supported entries'],
      ...options,
    });
    this.name = 'VerificationContextUnsupportedBoundaryError';
  }
}

export class VerificationContextStaleError extends PublicCommandError {
  constructor(message = 'Supplied verification context is stale.', options = {}) {
    super(message, {
      code: 'verification.context.stale',
      evidenceState: 'stale',
      disposition: 'superseded',
      committedStateEvaluated: false,
      safeRepair: 'Re-observe the verification context against current state, then rerun without changing committed state.',
      requiredContext: ['a freshly observed verification context for the requested evaluation'],
      ...options,
    });
    this.name = 'VerificationContextStaleError';
  }
}

export class BaselineChangedError extends PublicCommandError {
  constructor(message = 'The current task contract differs from its trusted baseline.') {
    super(message, {
      code: 'contract.baseline.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      safeRepair: 'Re-evaluate the current task contract and record an authorized correction before rerunning.',
    });
    this.name = 'BaselineChangedError';
  }
}

/** Convert typed validation findings to one stable public command error. */
export function publicErrorFromFindings(findings, {
  fallbackCode = 'verification.context.malformed',
  fallbackMessage = 'Supplied verification context is malformed.',
  fallbackRepair = 'Repair or regenerate the verification context, then rerun without changing committed state.',
} = {}) {
  const items = Array.isArray(findings) ? findings : [];
  const primary = items.reduce((best, item) => {
    if (!best) return item;
    const candidateRank = evidenceStateRank(item?.evidenceState);
    const bestRank = evidenceStateRank(best?.evidenceState);
    return candidateRank < bestRank ? item : best;
  }, null);
  const message = String(primary?.message ?? fallbackMessage);
  const declaredEvidenceState = primary?.evidenceState ?? 'malformed';
  const evidenceState = normalizeEvidenceState(declaredEvidenceState);
  return new PublicCommandError(message, {
    code: String(primary?.code ?? fallbackCode),
    evidenceState,
    disposition: evidenceState === declaredEvidenceState
      ? String(primary?.disposition ?? dispositionForEvidenceState(evidenceState))
      : dispositionForEvidenceState(evidenceState),
    publicMessage: message,
    safeRepair: FINDING_REPAIR[primary?.code] ?? fallbackRepair,
    committedStateEvaluated: false,
  });
}
