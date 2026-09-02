import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseRequiredCheckCommand, produceExecutionEvidence, validateExecutionEvidence } from '../src/execution-evidence.js';
import { canonicalSha256 } from '../src/canonical-json.js';

function runEvidence(overrides = {}, options = {}) {
  const wall = [Date.parse('2026-08-12T10:00:00.000Z'), Date.parse('2026-08-12T10:00:01.000Z')];
  const monotonic = [10, 17];
  return produceExecutionEvidence({
    checkId: 'RC-1',
    instruction: 'Run the exact portable command.',
    command: 'node',
    args: ['script with spaces.js', '--name', 'a b'],
    carrierRoot: '/repo',
    artifactWorktreeRoot: '/repo',
    workingDirectory: '/repo/packages/a',
    projectScratchRoot: '/repo/.agenticloop/tmp',
    binding: {
      packetId: 'dispatch:11111111-1111-4111-8111-111111111111',
      packetDigest: `sha256:agenticloop.role-preparation.v8:${'a'.repeat(64)}`,
      invocationId: 'invocation:example', taskId: 'T-001',
      taskContractDigest: `sha256:v1:${'b'.repeat(64)}`,
      currentCarrierDigest: `sha256:${'c'.repeat(64)}`,
      repositoryHead: 'd'.repeat(40), productHead: 'e'.repeat(40),
    },
    ...overrides,
  }, {
    now: () => wall.shift(),
    monotonicNow: () => monotonic.shift(),
    pathOptions: options.pathOptions ?? { platform: 'posix', exists: () => false },
    run: options.run ?? (() => ({ exitCode: 0, stdout: 'green', stderr: '' })),
    outputFilter: options.outputFilter,
  });
}

/** Real-host locations: every root is the actual working directory. */
function realLocations() {
  const cwd = process.cwd();
  return {
    carrierRoot: cwd,
    artifactWorktreeRoot: cwd,
    workingDirectory: cwd,
    projectScratchRoot: join(cwd, '.agenticloop', 'tmp'),
  };
}

describe('portable execution evidence', () => {
  it('parses only inert required-check argv and rejects shell interpretation', () => {
    assert.deepEqual(parseRequiredCheckCommand('node --version'), { command: 'node', args: ['--version'] });
    for (const command of ['node --version; whoami', 'node $HOME', 'node "unterminated']) {
      assert.throws(() => parseRequiredCheckCommand(command), /required command/);
    }
  });

  it('records exact argv, strict UTC timing, bounded monotonic duration, and project scratch', () => {
    const evidence = runEvidence();
    assert.deepEqual(evidence.check.args, ['script with spaces.js', '--name', 'a b']);
    assert.equal(evidence.timing.startedAt, '2026-08-12T10:00:00.000Z');
    assert.equal(evidence.timing.endedAt, '2026-08-12T10:00:01.000Z');
    assert.equal(evidence.timing.monotonicDurationMs, 7);
    assert.equal(evidence.locations.projectScratchRoot.authorityPath, '/repo/.agenticloop/tmp');
    assert.equal(evidence.execution.outcome, 'passed');
    assert.deepEqual(evidence.runner, {
      logicalCommand: 'node', resolvedExecutable: 'node', wrapperKind: 'native', wrapperProgram: null, wrapperArgs: [],
    });
    assert.equal(evidence.binding.invocationId, 'invocation:example');
    assert.equal(validateExecutionEvidence(evidence).ok, true);
  });

  it('distinguishes true non-zero child, wrapper, and output-filter failures', () => {
    const failed = runEvidence({}, { run: () => ({ exitCode: 23, stdout: '', stderr: 'nope' }) });
    assert.equal(failed.execution.outcome, 'child_failed');
    assert.equal(failed.execution.childExitCode, 23);

    const wrapper = runEvidence({}, { run: () => { throw new Error('spawn unavailable'); } });
    assert.equal(wrapper.execution.outcome, 'wrapper_failed');
    assert.equal(wrapper.execution.childExitCode, null);
    assert.equal(wrapper.execution.wrapperFailure, 'spawn unavailable');

    const filtered = runEvidence({}, { outputFilter: () => { throw new Error('redaction broke'); } });
    assert.equal(filtered.execution.outcome, 'output_filter_failed');
    assert.equal(filtered.execution.childExitCode, 0);
    assert.equal(filtered.execution.outputFilterFailure, 'redaction broke');
  });

  it('rejects system temp or a forged authority identity as project scratch', () => {
    assert.throws(() => runEvidence({ projectScratchRoot: '/tmp/agenticloop' }), /scratch root/);
    const evidence = runEvidence();
    const forged = structuredClone(evidence);
    forged.locations.workingDirectory.authorityPath = '/other';
    assert.equal(validateExecutionEvidence(forged).ok, false);
  });

  function realRunner({ command, args, cwd }) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
    if (result.error) throw result.error;
    return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function powerShellBinary() {
    for (const candidate of ['pwsh', 'powershell']) {
      const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf-8' });
      if (!probe.error && probe.status === 0) return candidate;
    }
    return null;
  }

  it('preserves a true non-zero child exit from a real PowerShell execution', t => {
    const binary = powerShellBinary();
    if (binary === null) {
      t.skip('no PowerShell binary on this host; PowerShell runtime proof is unavailable here');
      return;
    }
    const evidence = runEvidence({
      ...realLocations(),
      instruction: 'Run the exact portable command.',
      command: binary,
      args: ['-NoProfile', '-Command', 'exit 3'],
    }, { run: realRunner, pathOptions: { platform: process.platform } });
    assert.equal(evidence.execution.outcome, 'child_failed');
    assert.equal(evidence.execution.childExitCode, 3);
    assert.equal(evidence.execution.wrapperFailure, null);
    assert.equal(validateExecutionEvidence(evidence).ok, true);

    const passed = runEvidence({
      ...realLocations(),
      command: binary,
      args: ['-NoProfile', '-Command', 'Write-Output ok'],
    }, { run: realRunner, pathOptions: { platform: process.platform } });
    assert.equal(passed.execution.outcome, 'passed');
    assert.equal(passed.execution.childExitCode, 0);
    assert.match(passed.execution.output.stdout, /ok/);
  });

  it('preserves a true non-zero child exit from a real POSIX shell execution', t => {
    if (process.platform === 'win32') {
      // Honest platform disclosure: this host has no POSIX /bin/sh, so the
      // POSIX runtime proof remains pending rather than claimed. The injected
      // platform tests above cover the semantics; CI must run this on POSIX.
      t.skip('POSIX shell unavailable on this Windows host');
      return;
    }
    const evidence = runEvidence({
      ...realLocations(),
      command: '/bin/sh',
      args: ['-c', 'exit 4'],
    }, { run: realRunner, pathOptions: { platform: process.platform } });
    assert.equal(evidence.execution.outcome, 'child_failed');
    assert.equal(evidence.execution.childExitCode, 4);
    assert.equal(validateExecutionEvidence(evidence).ok, true);

    const passed = runEvidence({
      ...realLocations(),
      command: '/bin/sh',
      args: ['-c', 'printf ok'],
    }, { run: realRunner, pathOptions: { platform: process.platform } });
    assert.equal(passed.execution.outcome, 'passed');
    assert.match(passed.execution.output.stdout, /ok/);
  });

  it('rejects execution evidence with forged digest', () => {
    const evidence = runEvidence();
    const forged = structuredClone(evidence);
    forged.digest = 'sha256:forged' + '0'.repeat(55);
    assert.equal(validateExecutionEvidence(forged).ok, false);
  });

  it('treats schema-v2 evidence as a typed incompatible artifact rather than reinterpreting it', () => {
    const legacy = structuredClone(runEvidence());
    legacy.schemaVersion = 2;
    const checked = validateExecutionEvidence(legacy);
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /schemaVersion 2 is incompatible/);
  });

  it('preserves the actual Windows wrapper program and argv supplied by the runner', () => {
    const evidence = runEvidence({}, {
      run: () => ({
        exitCode: 0, stdout: 'green', stderr: '', logicalCommand: 'node',
        resolvedExecutable: 'C:\\Program Files\\nodejs\\npm.cmd', wrapperKind: 'windows_cmd_shim',
        wrapperProgram: 'cmd.exe', wrapperArgs: ['/d', '/s', '/c', '"npm.cmd --version"'],
      }),
    });
    assert.equal(evidence.runner.wrapperProgram, 'cmd.exe');
    assert.deepEqual(evidence.runner.wrapperArgs.slice(0, 3), ['/d', '/s', '/c']);
  });

  it('rejects execution evidence with any mutated binding field', () => {
    const evidence = runEvidence();
    const mutations = {
      packetId: 'dispatch:99999999-9999-4999-8999-999999999999',
      packetDigest: `sha256:agenticloop.role-preparation.v8:${'9'.repeat(64)}`,
      invocationId: 'invocation:forged',
      taskId: 'T-FORGED',
      taskContractDigest: `sha256:v1:${'9'.repeat(64)}`,
      productHead: '9'.repeat(40),
    };

    for (const [field, mutation] of Object.entries(mutations)) {
      const forged = structuredClone(evidence);
      forged.binding[field] = mutation;
      const { digest, ...unsigned } = forged;
      forged.digest = `sha256:agenticloop.execution-evidence.v4:${canonicalSha256(unsigned)}`;
      const checked = validateExecutionEvidence(forged, { expectedBinding: evidence.binding });
      assert.equal(checked.ok, false, `mutated binding.${field} should be rejected`);
      assert.equal(checked.diagnostics.at(-1).field, field);
      assert.equal(checked.diagnostics.at(-1).repair, 'rerun');
    }
  });

  it('validates workflow lineage separately from immutable product identity', () => {
    const evidence = runEvidence();
    const moved = structuredClone(evidence);
    moved.lineage.currentCarrierDigest = `sha256:${'9'.repeat(64)}`;
    moved.lineage.repositoryHead = '9'.repeat(40);
    const { digest, ...unsigned } = moved;
    moved.digest = `sha256:agenticloop.execution-evidence.v4:${canonicalSha256(unsigned)}`;
    const checked = validateExecutionEvidence(moved, { expectedBinding: {
      ...evidence.binding,
      currentCarrierDigest: `sha256:${'8'.repeat(64)}`,
      repositoryHead: '8'.repeat(40),
    } });
    assert.equal(checked.ok, false);
    assert.ok(checked.diagnostics.some(item => item.field === 'currentCarrierDigest' && item.repair === 'workflow_lineage_repair'));
    assert.ok(checked.diagnostics.some(item => item.field === 'repositoryHead' && item.repair === 'rerun'));
  });

  it('rejects execution evidence with mutated timing', () => {
    const evidence = runEvidence();
    const forged = structuredClone(evidence);
    forged.timing.startedAt = '2026-01-01T00:00:00.000Z';
    assert.equal(validateExecutionEvidence(forged).ok, false);
  });

  it('rejects execution evidence with mutated execution outcome', () => {
    const evidence = runEvidence();
    const forged = structuredClone(evidence);
    forged.execution.outcome = 'child_failed';
    assert.equal(validateExecutionEvidence(forged).ok, false);
  });

  it('rejects execution evidence with extra fields', () => {
    const evidence = runEvidence();
    const forged = { ...evidence, extra: 'field' };
    assert.equal(validateExecutionEvidence(forged).ok, false);
  });

  it('rejects execution evidence with missing fields', () => {
    const evidence = runEvidence();
    const { check, ...withoutCheck } = evidence;
    assert.equal(validateExecutionEvidence(withoutCheck).ok, false);
  });

  it('records exact check instruction and command identity', () => {
    const evidence = runEvidence({
      instruction: 'Run the exact portable command.',
      command: 'node',
      args: ['script.js', '--flag'],
    });
    assert.equal(evidence.check.instruction, 'Run the exact portable command.');
    assert.equal(evidence.check.command, 'node');
    assert.deepEqual(evidence.check.args, ['script.js', '--flag']);
  });

  it('preserves all binding identities', () => {
    const evidence = runEvidence();
    assert.equal(evidence.binding.packetId, 'dispatch:11111111-1111-4111-8111-111111111111');
    assert.equal(evidence.binding.taskId, 'T-001');
    assert.equal(evidence.binding.invocationId, 'invocation:example');
    assert.ok(evidence.binding.taskContractDigest.startsWith('sha256:v1:'));
    assert.ok(evidence.binding.packetDigest.startsWith('sha256:agenticloop.role-preparation.v8:'));
    assert.ok(evidence.lineage.currentCarrierDigest.startsWith('sha256:'));
    assert.equal(evidence.lineage.repositoryHead, 'd'.repeat(40));
    assert.equal(evidence.binding.productHead, 'e'.repeat(40));
  });
});
