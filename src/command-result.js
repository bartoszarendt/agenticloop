/** Canonical distinction between host transport and the native child command. */

export function classifyCommandResult(input = {}) {
  if (input.transportCompleted !== true) {
    return Object.freeze({ ok: false, state: 'transport_failure', maskedByPipeline: false });
  }
  const childExitCode = Number.isInteger(input.childExitCode) ? input.childExitCode : null;
  const pipelineExitCode = Number.isInteger(input.pipelineExitCode) ? input.pipelineExitCode : childExitCode;
  const maskedByPipeline = childExitCode !== null && childExitCode !== 0 && pipelineExitCode === 0;
  if (childExitCode === null || childExitCode !== 0) {
    return Object.freeze({ ok: false, state: 'command_failed', maskedByPipeline });
  }
  const disposition = typeof input.structuredDisposition === 'string'
    ? input.structuredDisposition
    : null;
  if (disposition && !['proceed', 'committed', 'already_current', 'dry_run', 'proposal_exported'].includes(disposition)) {
    return Object.freeze({ ok: false, state: 'structured_refusal', maskedByPipeline: false });
  }
  return Object.freeze({ ok: true, state: 'success', maskedByPipeline: false });
}
