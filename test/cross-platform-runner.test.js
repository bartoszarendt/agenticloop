import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveExecutablePath,
  classifyWrapper,
  resolvePowerShellProgram,
  windowsQuoteArgument,
  runRequiredCheckCommand,
  createProductionRunner,
} from '../src/cross-platform-runner.js';

function captureWindowsCmdShimInvocation(argument) {
  const directory = mkdtempSync(join(tmpdir(), 'agenticloop-cmd-shim-'));
  const shim = join(directory, 'runner.cmd');
  writeFileSync(shim, '@echo off\r\n', 'utf-8');
  const calls = [];

  try {
    runRequiredCheckCommand({ command: shim, args: [argument], cwd: directory }, {
      platform: 'win32',
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  assert.equal(calls.length, 1);
  return { shim, ...calls[0] };
}

function runWindowsCmdShimWithArgument(argument) {
  const directory = mkdtempSync(join(tmpdir(), 'agenticloop-cmd-shim-'));
  const shim = join(directory, 'runner.cmd');
  const received = join(directory, 'received.txt');
  writeFileSync(shim, '@echo off\r\n> "%~dp0received.txt" echo %~1\r\n', 'utf-8');

  try {
    const result = runRequiredCheckCommand({ command: shim, args: [argument], cwd: directory });
    return { directory, received, result };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

describe('cross-platform runner', () => {
  describe('windowsQuoteArgument', () => {
    it('passes through safe characters without quoting', () => {
      assert.equal(windowsQuoteArgument('hello'), 'hello');
      assert.equal(windowsQuoteArgument('--version'), '--version');
      assert.equal(windowsQuoteArgument('file.txt'), 'file.txt');
    });

    it('quotes arguments containing spaces', () => {
      assert.equal(windowsQuoteArgument('hello world'), '"hello world"');
    });

    it('escapes cmd.exe metacharacters with carets', () => {
      const result = windowsQuoteArgument('a(b)c');
      assert.ok(result.includes('^('), `should escape ( with caret: ${result}`);
    });
  });

  describe('resolveExecutablePath', () => {
    it('resolves node from PATH on current platform', () => {
      const resolved = resolveExecutablePath('node');
      assert.ok(resolved, 'node should be resolvable from PATH');
      assert.ok(existsSync(resolved), 'resolved path should exist');
    });

    it('returns null for empty or invalid commands', () => {
      assert.equal(resolveExecutablePath(''), null);
      assert.equal(resolveExecutablePath(null), null);
      assert.equal(resolveExecutablePath(123), null);
    });

    it('handles absolute paths', () => {
      const nodePath = resolveExecutablePath('node');
      if (nodePath) {
        const absolute = resolveExecutablePath(nodePath);
        assert.ok(absolute);
      }
    });

    it('resolves .cmd shims on Windows', t => {
      if (process.platform !== 'win32') {
        t.skip('Windows-only test');
        return;
      }
      // npm is typically a .cmd shim on Windows
      const npmPath = resolveExecutablePath('npm');
      if (npmPath) {
        assert.ok(npmPath.toLowerCase().endsWith('.cmd') || npmPath.toLowerCase().endsWith('.exe'));
      }
    });
  });

  describe('classifyWrapper', () => {
    it('classifies native executables', () => {
      assert.equal(classifyWrapper('/usr/bin/node', { platform: 'linux' }), 'native');
      assert.equal(classifyWrapper('C:\\node.exe', { platform: 'win32' }), 'native');
    });

    it('classifies .cmd and .bat as windows_cmd_shim', () => {
      assert.equal(classifyWrapper('C:\\npm.cmd', { platform: 'win32' }), 'windows_cmd_shim');
      assert.equal(classifyWrapper('C:\\script.bat', { platform: 'win32' }), 'windows_cmd_shim');
    });

    it('classifies .ps1 as powershell_script', () => {
      assert.equal(classifyWrapper('C:\\script.ps1', { platform: 'win32' }), 'powershell_script');
    });

    it('returns null for null input', () => {
      assert.equal(classifyWrapper(null), null);
    });
  });

  describe('PowerShell scripts', () => {
    it('uses a shell-free, exact PowerShell argv for .ps1 scripts', () => {
      const directory = mkdtempSync(join(tmpdir(), 'agenticloop-ps1-'));
      const script = join(directory, 'script with spaces.ps1');
      writeFileSync(script, 'exit 0\n', 'utf8');
      const calls = [];
      try {
        const result = runRequiredCheckCommand({ command: script, args: ['a b', '& inert'], cwd: directory }, {
          platform: 'win32',
          powerShellProgram: 'pwsh.exe',
          spawn(command, args, options) {
            calls.push({ command, args, options });
            return { status: 0, stdout: 'ok', stderr: '' };
          },
        });
        assert.equal(result.wrapperKind, 'powershell_script');
        assert.equal(result.wrapperProgram, 'pwsh.exe');
        assert.deepEqual(result.wrapperArgs, ['-NoProfile', '-NonInteractive', '-File', script, 'a b', '& inert']);
        assert.equal(calls[0].command, 'pwsh.exe');
        assert.equal(calls[0].options.shell, false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('preserves PowerShell wrapper identity on launch failure and child failure', () => {
      const directory = mkdtempSync(join(tmpdir(), 'agenticloop-ps1-'));
      const script = join(directory, 'script.ps1');
      writeFileSync(script, 'exit 0\n', 'utf8');
      try {
        assert.throws(() => runRequiredCheckCommand({ command: script, args: [], cwd: directory }, {
          platform: 'win32', powerShellProgram: 'powershell.exe',
          spawn: () => ({ error: Object.assign(new Error('missing wrapper'), { code: 'ENOENT' }) }),
        }), error => error.wrapperKind === 'powershell_script' && error.wrapperProgram === 'powershell.exe' &&
          JSON.stringify(error.wrapperArgs) === JSON.stringify(['-NoProfile', '-NonInteractive', '-File', script]));
        const result = runRequiredCheckCommand({ command: script, args: ['; inert'], cwd: directory }, {
          platform: 'win32', powerShellProgram: 'powershell.exe',
          spawn: () => ({ status: 23, stdout: '', stderr: 'child failed' }),
        });
        assert.equal(result.exitCode, 23);
        assert.equal(result.wrapperProgram, 'powershell.exe');
        assert.deepEqual(result.wrapperArgs, ['-NoProfile', '-NonInteractive', '-File', script, '; inert']);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('resolves a Windows PowerShell host only on Windows resolution paths', () => {
      assert.equal(resolvePowerShellProgram({ platform: 'linux' }), null);
    });

    it('uses Windows PATH separators during injected PowerShell resolution', () => {
      const directory = mkdtempSync(join(tmpdir(), 'agenticloop-pwsh-'));
      const host = join(directory, 'pwsh.exe');
      writeFileSync(host, '', 'utf8');
      try {
        assert.equal(resolvePowerShellProgram({
          platform: 'win32', pathEnv: `missing;${directory}`, pathExt: '.EXE', cwd: directory,
        }), host);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe('runRequiredCheckCommand', () => {
    it('executes node --version successfully', () => {
      const result = runRequiredCheckCommand({ command: 'node', args: ['--version'], cwd: process.cwd() });
      assert.equal(typeof result.exitCode, 'number');
      assert.ok(result.stdout.length > 0 || result.stderr.length > 0);
      assert.equal(result.logicalCommand, 'node');
      assert.ok(result.resolvedExecutable);
    });

    it('captures non-zero exit codes', () => {
      const result = runRequiredCheckCommand({ command: 'node', args: ['-e', 'process.exit(42)'], cwd: process.cwd() });
      assert.equal(result.exitCode, 42);
    });

    it('throws on missing executable', () => {
      assert.throws(() => {
        runRequiredCheckCommand({ command: 'nonexistent-binary-xyz', args: [], cwd: process.cwd() });
      });
    });

    it('preserves wrapper identity', () => {
      const result = runRequiredCheckCommand({ command: 'node', args: ['--version'], cwd: process.cwd() });
      assert.equal(result.logicalCommand, 'node');
      assert.ok(result.wrapperKind);
      assert.equal(result.wrapperProgram, null);
      assert.deepEqual(result.wrapperArgs, []);
    });

    it('reports cmd wrapper argv, spaces, and inert metacharacters deterministically', () => {
      const { command, args, options } = captureWindowsCmdShimInvocation('a b & | > %value%');
      assert.equal(command, 'cmd.exe');
      assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
      assert.match(args[3], /\^&/);
      assert.equal(options.shell, false);
      assert.equal(options.windowsVerbatimArguments, true);
    });

    it('reports wrapper launch failures with the same wrapper identity', () => {
      const directory = mkdtempSync(join(tmpdir(), 'agenticloop-cmd-shim-'));
      writeFileSync(join(directory, 'npm.cmd'), '@echo off\r\n', 'utf8');
      try {
        assert.throws(() => runRequiredCheckCommand({ command: 'npm', args: [], cwd: directory }, {
          platform: 'win32', pathEnv: directory, pathExt: '.cmd',
          spawn() { return { error: Object.assign(new Error('cmd unavailable'), { code: 'ENOENT' }) }; },
        }), error => error.wrapperKind === 'windows_cmd_shim' && error.wrapperProgram === 'cmd.exe' &&
          Array.isArray(error.wrapperArgs));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('executes npm on Windows through cmd.exe shim', t => {
      if (process.platform !== 'win32') {
        t.skip('Windows-only test');
        return;
      }
      const result = runRequiredCheckCommand({ command: 'npm', args: ['--version'], cwd: process.cwd() });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.trim().length > 0);
      assert.equal(result.wrapperKind, 'windows_cmd_shim');
      assert.equal(result.wrapperProgram, 'cmd.exe');
      assert.equal(result.wrapperArgs.slice(0, 3).join(' '), '/d /s /c');
    });

    it('executes npx on Windows through cmd.exe shim', t => {
      if (process.platform !== 'win32') {
        t.skip('Windows-only test');
        return;
      }
      const result = runRequiredCheckCommand({ command: 'npx', args: ['--version'], cwd: process.cwd() });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.trim().length > 0);
      assert.equal(result.wrapperKind, 'windows_cmd_shim');
      assert.equal(result.wrapperProgram, 'cmd.exe');
    });

    for (const [description, buildArgument] of [
      ['does not execute secondary commands from & arguments', marker => `safe & type nul > "${marker}"`],
      ['does not create pipes from | arguments', marker => `safe | type nul > "${marker}"`],
      ['does not redirect output from > arguments', marker => `safe > "${marker}"`],
      ['does not expand variables from %VAR% arguments', () => 'safe %AGENTICLOOP_ADVERSARIAL_VAR%'],
      ['does not interpret ^ arguments as escapes', marker => `safe ^& type nul > "${marker}"`],
    ]) {
      it(description, t => {
        if (process.platform !== 'win32') {
          t.skip('Windows-only test');
          return;
        }

        const marker = join(tmpdir(), `agenticloop-injected-${process.pid}-${Date.now()}.txt`);
        const argument = buildArgument(marker);
        const previous = process.env.AGENTICLOOP_ADVERSARIAL_VAR;
        process.env.AGENTICLOOP_ADVERSARIAL_VAR = 'expanded';
        const { directory, received, result } = runWindowsCmdShimWithArgument(argument);
        try {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(existsSync(marker), false, 'argument must not execute cmd.exe syntax');
          assert.equal(readFileSync(received, 'utf-8').trim(), argument);
        } finally {
          if (previous === undefined) delete process.env.AGENTICLOOP_ADVERSARIAL_VAR;
          else process.env.AGENTICLOOP_ADVERSARIAL_VAR = previous;
          rmSync(marker, { force: true });
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }

    it('rejects empty command', () => {
      assert.throws(() => {
        runRequiredCheckCommand({ command: '', args: [], cwd: process.cwd() });
      }, /command must be a non-empty string/);
    });

    it('rejects non-string args', () => {
      assert.throws(() => {
        runRequiredCheckCommand({ command: 'node', args: [123], cwd: process.cwd() });
      }, /args must be a string array/);
    });
  });

  describe('createProductionRunner', () => {
    it('returns a function matching the produceExecutionEvidence interface', () => {
      const runner = createProductionRunner();
      assert.equal(typeof runner, 'function');
      const result = runner({ command: 'node', args: ['--version'], cwd: process.cwd() });
      assert.equal(typeof result.exitCode, 'number');
      assert.equal(typeof result.stdout, 'string');
      assert.equal(typeof result.stderr, 'string');
    });
  });
});
