/** Typed facts carried from real producer sites to the public CLI boundary. */

export const OPERATIONAL_FAILURE_MESSAGE =
  'The command could not complete because required operational context is unavailable.';

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
