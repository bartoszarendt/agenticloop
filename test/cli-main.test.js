import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCliInProcess } from './helpers/run-cli.js';

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-cli-main-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describe('runCli programmatic contract', () => {
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

  it('passes the injected environment to an isolated legacy command', async () => {
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
    assert.equal(readFileSync(marker, 'utf-8'), 'injected');
  });

  it('keeps concurrent legacy exit codes independent and preserves process state', async () => {
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

      assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
      assert.equal(valid.status, 0, valid.stdout + valid.stderr);
      assert.equal(process.exitCode, 23);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
