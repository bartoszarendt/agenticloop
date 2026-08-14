/**
 * Cross-platform process execution for required-check commands.
 *
 * Accepts only already-parsed inert argv. Never interprets command text as
 * shell syntax. On Windows, resolves `.cmd` and `.bat` shims through
 * `cmd.exe /d /s /c`, and `.ps1` scripts through an exact PowerShell argv.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join, resolve as resolvePath } from 'node:path';

const WINDOWS_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];
const DEFAULT_TIMEOUT_MS = 300_000;

function isWindows() {
  return process.platform === 'win32';
}

/**
 * Quote one argument for Windows cmd.exe. Uses double-quote wrapping with
 * caret-escaping for the special cmd.exe metacharacters. This is the
 * cmd.exe-specific quoting; it is NOT shell quoting.
 */
export function windowsQuoteArgument(value) {
  const string = String(value);
  if (/^[A-Za-z0-9._\-/=:@]+$/.test(string)) return string;
  return `"${string.replace(/([()%!^"&|;<>])/g, '^$1')}"`;
}

/**
 * Look up an executable on PATH. On Windows, tries each PATHEXT extension.
 * Returns the resolved absolute path or null.
 */
export function resolveExecutablePath(command, { platform = process.platform, pathEnv = process.env.PATH, pathExt = process.env.PATHEXT, cwd = process.cwd() } = {}) {
  if (!command || typeof command !== 'string') return null;
  const isAbsolute = platform === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(command) || command.startsWith('\\\\')
    : command.startsWith('/');
  if (isAbsolute) {
    if (platform === 'win32') {
      const resolved = resolveWithExt(command, pathExt);
      if (resolved) return resolved;
      return existsSync(command) ? command : null;
    }
    return existsSync(command) ? command : null;
  }
  if (platform === 'win32' && (command.includes('\\') || command.includes('/'))) {
    const absolute = resolvePath(cwd, command);
    const resolved = resolveWithExt(absolute, pathExt);
    if (resolved) return resolved;
    return existsSync(absolute) ? absolute : null;
  }
  if (platform !== 'win32' && command.includes('/')) {
    const absolute = resolvePath(cwd, command);
    return existsSync(absolute) ? absolute : null;
  }
  // `platform` is injectable for deterministic Windows tests, so PATH parsing
  // must follow the selected platform rather than this process's host OS.
  const dirs = (pathEnv || '').split(platform === 'win32' ? ';' : delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (platform === 'win32') {
      const resolved = resolveWithExt(candidate, pathExt);
      if (resolved) return resolved;
    } else if (existsSync(candidate)) {
      try {
        statSync(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function resolveWithExt(base, pathExt) {
  const exts = pathExt ? pathExt.split(';').filter(Boolean) : WINDOWS_PATHEXT;
  // On Windows, prefer .cmd/.bat/.exe extensions over extensionless files.
  // This ensures npm.cmd is found before the extensionless npm shell script.
  for (const ext of exts) {
    const candidate = base + (ext.startsWith('.') ? ext : `.${ext}`);
    if (existsSync(candidate)) {
      try { statSync(candidate); return candidate; } catch { continue; }
    }
  }
  // Fall back to the base path itself only if no extension match found
  if (existsSync(base)) {
    try { statSync(base); return base; } catch { /* fall through */ }
  }
  return null;
}

/** Resolve the PowerShell host program without using a command interpreter. */
export function resolvePowerShellProgram(options = {}) {
  const { platform = process.platform } = options;
  if (platform !== 'win32') return null;
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    const resolved = resolveExecutablePath(candidate, options);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Identify the wrapper kind for a resolved executable path.
 */
export function classifyWrapper(resolvedPath, { platform = process.platform } = {}) {
  if (!resolvedPath) return null;
  const lower = resolvedPath.toLowerCase();
  if (platform === 'win32') {
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return 'windows_cmd_shim';
    if (lower.endsWith('.ps1')) return 'powershell_script';
  }
  return 'native';
}

/**
 * Execute one inert argv through the production runner. Returns a closed
 * result shape. On Windows, when the resolved executable is a .cmd/.bat shim,
 * routes through cmd.exe /d /s /c with caret-escaped arguments.
 *
 * The `platform` and `spawn` options exist only for deterministic tests.
 */
export function runRequiredCheckCommand({ command, args, cwd }, {
  platform = process.platform,
  timeout = DEFAULT_TIMEOUT_MS,
  spawn = defaultSpawn,
  pathEnv = process.env.PATH,
  pathExt = process.env.PATHEXT,
  powerShellProgram = null,
} = {}) {
  if (!command || typeof command !== 'string') {
    throw new TypeError('command must be a non-empty string');
  }
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
    throw new TypeError('args must be a string array');
  }

  const resolution = { platform, cwd, pathEnv, pathExt };
  const resolved = resolveExecutablePath(command, resolution);
  const wrapperKind = classifyWrapper(resolved, { platform });

  if (platform === 'win32' && wrapperKind === 'windows_cmd_shim') {
    const quotedExecutable = windowsQuoteArgument(resolved);
    const quotedArgs = args.map(windowsQuoteArgument);
    // /s ensures cmd.exe treats the first and last quotes as delimiters.
    const cmdLine = `"${quotedExecutable}${quotedArgs.length ? ` ${quotedArgs.join(' ')}` : ''}"`;
    const wrapperProgram = 'cmd.exe';
    const wrapperArgs = ['/d', '/s', '/c', cmdLine];
    const result = spawn(wrapperProgram, wrapperArgs, {
      cwd, encoding: 'utf-8', shell: false, windowsHide: true, windowsVerbatimArguments: true, timeout,
    });
    return finalizeResult(result, {
      logicalCommand: command, resolvedExecutable: resolved, wrapperKind,
      wrapperProgram, wrapperArgs,
    });
  }

  if (platform === 'win32' && wrapperKind === 'powershell_script') {
    const wrapperProgram = powerShellProgram ?? resolvePowerShellProgram(resolution);
    const wrapperArgs = ['-NoProfile', '-NonInteractive', '-File', resolved, ...args];
    if (!wrapperProgram) {
      const error = new Error('PowerShell is unavailable for a .ps1 required-check script');
      error.logicalCommand = command;
      error.resolvedExecutable = resolved;
      error.wrapperKind = wrapperKind;
      error.wrapperProgram = null;
      error.wrapperArgs = wrapperArgs;
      throw error;
    }
    const result = spawn(wrapperProgram, wrapperArgs, {
      cwd, encoding: 'utf-8', shell: false, windowsHide: true, timeout,
    });
    return finalizeResult(result, {
      logicalCommand: command, resolvedExecutable: resolved, wrapperKind,
      wrapperProgram, wrapperArgs,
    });
  }

  const executable = resolved || command;
  const result = spawn(executable, [...args], {
    cwd, encoding: 'utf-8', shell: false, windowsHide: true, timeout,
  });
  return finalizeResult(result, {
    logicalCommand: command,
    resolvedExecutable: resolved || command,
    wrapperKind: resolved ? (wrapperKind || 'native') : 'unresolved',
    wrapperProgram: null,
    wrapperArgs: [],
  });
}

function finalizeResult(result, identity) {
  if (result.error) {
    const wrapped = new Error(result.error.message);
    wrapped.code = result.error.code;
    wrapped.logicalCommand = identity.logicalCommand;
    wrapped.resolvedExecutable = identity.resolvedExecutable;
    wrapped.wrapperKind = identity.wrapperKind;
    wrapped.wrapperProgram = identity.wrapperProgram;
    wrapped.wrapperArgs = identity.wrapperArgs;
    throw wrapped;
  }
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    logicalCommand: identity.logicalCommand,
    resolvedExecutable: identity.resolvedExecutable,
    wrapperKind: identity.wrapperKind,
    wrapperProgram: identity.wrapperProgram,
    wrapperArgs: identity.wrapperArgs,
  };
}

function defaultSpawn(command, args, options) {
  return spawnSync(command, args, options);
}

/**
 * Production runner adapter matching the produceExecutionEvidence interface.
 */
export function createProductionRunner(options = {}) {
  return function productionRunner({ command, args, cwd }) {
    return runRequiredCheckCommand({ command, args, cwd }, options);
  };
}
