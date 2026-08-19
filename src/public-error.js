/** Typed facts carried from real producer sites to the public CLI boundary. */

import { dispositionForEvidenceState, evidenceStateRank, normalizeEvidenceState } from './result-envelope.js';

export const OPERATIONAL_FAILURE_MESSAGE =
  'The command could not complete because required operational context is unavailable.';

/**
 * One public sentence and one safe repair for "the expected carrier digest is
 * not the current carrier digest".
 *
 * Both task carriers evaluate committed state to reach this conclusion - each
 * reads the current record and compares it - so both report the same message,
 * the same repair, and `committedStateEvaluated: true`. Only the surrounding
 * envelope's carrier identity distinguishes them.
 */
export function staleCarrierDigestMessage(expected, current) {
  return `Stale task record: expected ${expected}, the current digest is ${current}.`;
}

export const STALE_CARRIER_DIGEST_CONTEXT = Object.freeze({
  code: 'contract.baseline.stale',
  evidenceState: 'changed',
  disposition: 'superseded',
  committedStateEvaluated: true,
  safeRepair: 'Refetch the task record, re-evaluate the trusted baseline, and rerun with its current digest.',
});

/** Shared files/GitHub classification for a semantically refused task transition. */
export const TASK_TRANSITION_NEGATIVE_CONTEXT = Object.freeze({
  code: 'evidence.negative',
  evidenceState: 'negative',
  disposition: 'blocked',
  committedStateEvaluated: true,
  safeRepair: 'Repair the reported task-transition condition, then rerun the operation.',
});

const FINDING_REPAIR = Object.freeze({
  'activation.capture.expired': 'Run npx agenticloop activate <task-id> to bind current operator-confirmed authority to the existing task, or obtain a fresh supported host capture when hardened host_signed assurance is required; never edit the expired capture.',
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

/**
 * One typed refusal for a producer that rejects the evidence its caller handed
 * it.
 *
 * A construction refusal is a fact about the caller's own evidence, not an
 * internal accident. Thrown as a bare `TypeError` it reaches a command boundary
 * obliged to erase its message: `commandFailure` replaces it with
 * `OPERATIONAL_FAILURE_MESSAGE`, and an uncaught one is rendered as
 * `cli.unexpected` - "validation or evaluation did not complete" - which reads
 * as a toolkit bug for what is in fact a precise, actionable refusal.
 *
 * Every producer whose refusal can reach a public command surface raises this
 * instead, so the sentence the producer already wrote is the sentence the
 * operator reads.
 */
export class ProducerRefusalError extends PublicCommandError {
  constructor(message, {
    code,
    safeRepair,
    evidenceState = 'malformed',
    disposition = 'rejected',
    committedStateEvaluated = false,
    ...rest
  } = {}) {
    const sentence = String(message);
    super(sentence, {
      code,
      evidenceState,
      disposition,
      publicMessage: sentence,
      safeRepair,
      committedStateEvaluated,
      ...rest,
    });
    this.name = 'ProducerRefusalError';
  }
}

/**
 * Bind one producer family's diagnostic code and safe repair once, and return
 * the thrower its refusal sites use.
 *
 * The code must already exist in the repair policy: a producer refusal names an
 * existing evidence fact, it does not introduce a new repair capability that
 * role declarations would have to own.
 */
export function producerRefusal({ code, safeRepair, committedStateEvaluated = false }) {
  return message => new ProducerRefusalError(message, { code, safeRepair, committedStateEvaluated });
}
