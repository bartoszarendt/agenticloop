import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCliInProcess } from './helpers/run-cli.js';
import { dispatch } from '../src/cli.js';
import { createIo } from '../src/cli-io.js';
import { BaselineChangedError } from '../src/public-error.js';
import { serializeValidationResult } from '../src/result-envelope.js';

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-cli-main-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describe('runCli programmatic contract', () => {
  it('contains non-Error throws in human mode and still returns an exit code', async () => {
    const target = mkdtempSync(join(tmpBase, 'undefined-failure-'));
    const result = await runCliInProcess([
      'task-body', 'fetch', '--issue', '31', '--output', 'task.md',
    ], {
      cwd: target,
      ghCommandRunner: () => { throw undefined; },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[cli\.unexpected\]/);
    assert.match(result.stderr, /debug reference:/);
    assert.doesNotMatch(result.stderr, /TypeError:|at runCli/);
  });

  it('classifies missing and malformed verification context without claiming evaluation', async () => {
    const target = mkdtempSync(join(tmpBase, 'verification-context-'));
    const task = join(target, 'task.md');
    const malformed = join(target, 'base-paths.json');
    writeFileSync(task, '---\nallowed_paths:\n  - src/**\n---\n# Task\n', 'utf8');
    writeFileSync(malformed, 'src/old.js', 'utf8');

    const malformedRun = await runCliInProcess([
      'task-readiness', '--task-body', task, '--base-paths', malformed, '--mode', 'review', '--json',
    ], { cwd: target });
    const malformedResult = JSON.parse(malformedRun.stdout);
    assert.equal(malformedRun.status, 1);
    assert.equal(malformedResult.evidenceState, 'malformed');
    assert.equal(malformedResult.disposition, 'rejected');
    assert.equal(malformedResult.diagnostics[0].code, 'verification.context.malformed');
    assert.equal(malformedResult.diagnostics[0].evidence.committedStateEvaluated, false);
    assert.ok(malformedResult.requiredContext[0].includes('valid JSON'));

    const missingRun = await runCliInProcess([
      'task-readiness', '--task-body', 'missing.md', '--base-paths', malformed, '--mode', 'review', '--json',
    ], { cwd: target });
    const missingResult = JSON.parse(missingRun.stdout);
    assert.equal(missingRun.status, 1);
    assert.equal(missingResult.evidenceState, 'missing');
    assert.equal(missingResult.disposition, 'needs_context');
    assert.equal(missingResult.diagnostics[0].code, 'verification.context.missing');
    assert.equal(missingResult.diagnostics[0].evidence.committedStateEvaluated, false);
    assert.ok(missingResult.requiredContext[0].includes('missing.md'));
  });

  it('uses typed producer facts rather than an injected error message at the public boundary', async () => {
    const target = mkdtempSync(join(tmpBase, 'public-failure-'));
    const runner = () => { throw new Error('baseline conflict: current task differs from the trusted baseline'); };
    const normal = await runCliInProcess([
      'task-body', 'fetch', '--issue', '31', '--output', 'task.md', '--json',
    ], { cwd: target, ghCommandRunner: runner });
    assert.equal(normal.status, 1);
    const envelope = JSON.parse(normal.stdout);
    assert.equal(envelope.kind, 'agenticloop.validation-result');
    assert.equal(envelope.evidenceState, 'missing');
    assert.equal(envelope.disposition, 'blocked');
    assert.equal(envelope.diagnostics[0].code, 'cli.unexpected');
    assert.equal(envelope.diagnostics[0].evidence.committedStateEvaluated, false);
    assert.equal(envelope.diagnostics[0].repairKind, 'repair_evidence');
    assert.deepEqual(envelope.requiredContext, []);
    assert.match(envelope.firstSafeRepair, /Rerun once with --debug/);
    assert.doesNotMatch(envelope.firstSafeRepair, /repair_command_environment|needs_context/);
    assert.equal(envelope.rollbackAuthorized, false);
    assert.doesNotMatch(normal.stdout + normal.stderr, /at .*cli\.js:\d+/);

    const debug = await runCliInProcess([
      'task-body', 'fetch', '--issue', '31', '--output', 'task.md', '--json', '--debug',
    ], { cwd: target, ghCommandRunner: runner });
    assert.equal(debug.status, 1);
    assert.match(debug.stderr, /Error: baseline conflict/);
    assert.match(debug.stderr, /at /);

    const typed = await runCliInProcess([
      'task-body', 'fetch', '--issue', '31', '--output', 'task.md', '--json',
    ], { cwd: target, ghCommandRunner: () => { throw new BaselineChangedError('reworded producer message'); } });
    const typedEnvelope = JSON.parse(typed.stdout);
    assert.equal(typedEnvelope.evidenceState, 'changed');
    assert.equal(typedEnvelope.diagnostics[0].code, 'contract.baseline.stale');
  });

  it('falls back to a static canonical envelope when public failure rendering also fails', async () => {
    const target = mkdtempSync(join(tmpBase, 'failure-fallback-'));
    const agents = join(target, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'maintainer.md'), [
      '---',
      'name: maintainer',
      'primary_repair_capabilities:',
      '  - repair_evidence',
      '---',
      '# Maintainer',
      '',
    ].join('\n'), 'utf8');
    const runner = () => { throw new TypeError('primary failure sentinel'); };

    const normal = await runCliInProcess([
      'task-body', 'fetch', '--issue', '31', '--output', 'task.md', '--json',
    ], { cwd: target, ghCommandRunner: runner });
    assert.equal(normal.status, 1, normal.stdout + normal.stderr);
    const envelope = JSON.parse(normal.stdout);
    assert.equal(envelope.diagnostics[0].code, 'cli.unexpected');
    assert.equal(envelope.diagnostics[0].evidence.committedStateEvaluated, false);
    assert.equal(envelope.disposition, 'blocked');
    assert.deepEqual(envelope.requiredContext, []);
    assert.equal(normal.stdout.trim(), serializeValidationResult(envelope));
    assert.equal(normal.stderr, '');
    assert.doesNotMatch(normal.stdout, /primary failure sentinel|invalid role capability bindings/);

    const debug = await runCliInProcess([
      'task-body', 'fetch', '--issue', '31', '--output', 'task.md', '--json', '--debug',
    ], { cwd: target, ghCommandRunner: runner });
    assert.equal(debug.status, 1, debug.stdout + debug.stderr);
    assert.doesNotThrow(() => JSON.parse(debug.stdout));
    assert.match(debug.stderr, /TypeError: primary failure sentinel/);
    assert.match(debug.stderr, /Failure rendering error: Error: invalid role capability bindings/);
  });

  it('uses the selected --target for command and public failure presentation', async () => {
    const host = mkdtempSync(join(tmpBase, 'target-routing-host-'));
    const target = mkdtempSync(join(tmpBase, 'target-routing-invalid-'));
    const task = join(host, 'task.md');
    writeFileSync(task, '---\nallowed_paths: [\"src/**\"]\n---\n# Task\n', 'utf8');
    const agents = join(target, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'maintainer.md'), [
      '---',
      'name: maintainer',
      'primary_repair_capabilities:',
      '  - repair_evidence',
      '---',
      '# Maintainer',
      '',
    ].join('\n'), 'utf8');

    const result = await runCliInProcess([
      'task-readiness', '--task-body', task, '--mode', 'review', '--target', target, '--json',
    ], { cwd: host });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.diagnostics[0].code, 'cli.unexpected');
    assert.equal(Object.hasOwn(envelope.diagnostics[0], 'owner'), false);
    assert.equal(result.stdout.trim(), serializeValidationResult(envelope));
  });

  it('recognizes --debug only in a flag position', async () => {
    const targetValue = await runCliInProcess(['status', '--target', '--debug'], {
      cwd: mkdtempSync(join(tmpBase, 'debug-value-')),
    });
    assert.equal(targetValue.status, 2, targetValue.stdout + targetValue.stderr);
    assert.doesNotMatch(targetValue.stderr, /\n\s*at /);

    const afterTerminator = await runCliInProcess(['status', '--', '--debug'], {
      cwd: mkdtempSync(join(tmpBase, 'debug-terminator-')),
    });
    assert.equal(afterTerminator.status, 2, afterTerminator.stdout + afterTerminator.stderr);
    assert.doesNotMatch(afterTerminator.stderr, /\n\s*at /);
  });

  it('does not convert programming errors at the dispatch unit boundary', async () => {
    const target = mkdtempSync(join(tmpBase, 'internal-error-'));
    const runner = () => { throw new TypeError('programming defect sentinel'); };
    await assert.rejects(
      dispatch(['task-body', 'fetch', '--issue', '31', '--output', 'task.md'], {
        ...createIo({ cwd: target }),
        ghCommandRunner: runner,
      }),
      /programming defect sentinel/
    );
  });

  it('captures legacy output and resolves its target from the injected cwd', async () => {
    const target = mkdtempSync(join(tmpBase, 'cwd-'));
    const initialized = await runCliInProcess([
      'init', '--target', target, '--adapter', 'opencode',
    ]);
    assert.equal(initialized.status, 0, initialized.stderr);

    const result = await runCliInProcess(['status'], { cwd: target });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenCode/i);
    assert.equal(result.stderr, '');
  });

  it('runs every command in-process without a subprocess bridge', async () => {
    // A NODE_OPTIONS --require probe would execute in a spawned child. Because
    // runCli is fully in-process, the probe must NOT run and the marker file
    // must stay absent while the command still honors the injected env.
    const target = mkdtempSync(join(tmpBase, 'env-'));
    const marker = join(target, 'environment.txt');
    const probe = join(target, 'environment-probe.cjs');
    writeFileSync(
      probe,
      "require('node:fs').writeFileSync(process.env.AGENTICLOOP_ENV_MARKER, process.env.AGENTICLOOP_ENV_VALUE);\n",
      'utf-8'
    );

    const result = await runCliInProcess(['status'], {
      cwd: target,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${probe}`,
        AGENTICLOOP_ENV_MARKER: marker,
        AGENTICLOOP_ENV_VALUE: 'injected',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false, 'no subprocess bridge may remain');
  });

  it('keeps concurrent in-process exit codes independent and preserves process state', async () => {
    const invalidTarget = mkdtempSync(join(tmpBase, 'invalid-'));
    const validTarget = mkdtempSync(join(tmpBase, 'valid-'));
    const previousExitCode = process.exitCode;
    process.exitCode = 23;

    try {
      const [invalid, valid] = await Promise.all([
        runCliInProcess([
          'init', '--target', invalidTarget, '--adapter', 'invalid-adapter',
        ]),
        runCliInProcess(['init', '--target', validTarget]),
      ]);

      assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
      assert.equal(valid.status, 0, valid.stdout + valid.stderr);
      assert.equal(process.exitCode, 23);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
