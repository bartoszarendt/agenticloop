import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommandResult } from '../src/command-result.js';

describe('command result classification', () => {
  it('distinguishes child success from transport completion', () => {
    assert.deepEqual(classifyCommandResult({ transportCompleted: true, childExitCode: 0, structuredDisposition: 'proceed' }),
      { ok: true, state: 'success', maskedByPipeline: false });
    assert.equal(classifyCommandResult({ transportCompleted: false }).state, 'transport_failure');
    assert.equal(classifyCommandResult({ transportCompleted: true, childExitCode: 7 }).state, 'command_failed');
  });

  it('keeps a structured refusal distinct from a non-zero child exit', () => {
    assert.deepEqual(classifyCommandResult({ transportCompleted: true, childExitCode: 0, structuredDisposition: 'blocked' }),
      { ok: false, state: 'structured_refusal', maskedByPipeline: false });
  });

  it('detects an upstream failure masked by a successful pipeline tail', () => {
    assert.deepEqual(classifyCommandResult({ transportCompleted: true, childExitCode: 1, pipelineExitCode: 0 }),
      { ok: false, state: 'command_failed', maskedByPipeline: true });
  });
});
