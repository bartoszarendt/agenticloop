/** Portable, host-neutral required-check execution evidence. */

import { canonicalSha256 } from './canonical-json.js';
import { pathIdentity, samePathAuthority } from './path-identity.js';

export const EXECUTION_EVIDENCE_KIND = 'agenticloop.execution-evidence';
export const EXECUTION_EVIDENCE_SCHEMA_VERSION = 3;
export const MAX_MONOTONIC_DURATION_MS = 31 * 24 * 60 * 60 * 1000;

const FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'check', 'runner', 'binding', 'timing', 'locations', 'execution', 'digest',
]);
const LOCATION_FIELDS = Object.freeze([
  'carrierRoot', 'artifactWorktreeRoot', 'workingDirectory', 'projectScratchRoot',
]);

/**
 * Parse a required command as inert argv. This is intentionally not a shell
 * parser: expansions, redirects, pipelines, control operators, globs, and
 * Windows percent expansion are rejected rather than interpreted.
 */
export function parseRequiredCheckCommand(instruction) {
  if (typeof instruction !== 'string' || !instruction.trim()) {
    throw new TypeError('required command must be a non-empty string');
  }
  if (/[\r\n'`$%!&|;<>()[\]{}*?~]/.test(instruction)) {
    throw new TypeError('required command cannot contain shell syntax or expansion characters');
  }
  const tokens = [];
  let value = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < instruction.length; index += 1) {
    const character = instruction[index];
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(value);
      value = '';
      started = false;
      continue;
    }
    if (character === '\\') {
      const next = instruction[index + 1];
      if (!quoted || next === undefined || next === '\\' || next === '"') {
        throw new TypeError('required command has unsupported escaping');
      }
    }
    value += character;
    started = true;
  }
  if (quoted || (!started && value)) throw new TypeError('required command has unterminated or empty quoting');
  if (started) tokens.push(value);
  if (tokens.length === 0 || tokens.some(token => !token)) throw new TypeError('required command cannot be parsed as inert argv');
  return Object.freeze({ command: tokens[0], args: Object.freeze(tokens.slice(1)) });
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
}

function strictUtc(value) {
  const parsed = Date.parse(value);
  return typeof value === 'string' && Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function evidenceDigest(value) {
  const { digest, ...unsigned } = value;
  return `sha256:agenticloop.execution-evidence.v3:${canonicalSha256(unsigned)}`;
}

/** Typed signal for an artifact from the retired v2 digest domain. */
export class ExecutionEvidenceStaleVersionError extends TypeError {
  constructor(observedVersion = 2) {
    super(`execution evidence schemaVersion ${observedVersion} is incompatible; produce fresh schemaVersion ${EXECUTION_EVIDENCE_SCHEMA_VERSION} evidence`);
    this.name = 'ExecutionEvidenceStaleVersionError';
    this.code = 'execution_evidence.stale_version';
    this.observedVersion = observedVersion;
    this.requiredVersion = EXECUTION_EVIDENCE_SCHEMA_VERSION;
  }
}

function locationRecord(value, options) {
  const identity = pathIdentity(value, options);
  return { displayPath: identity.displayPath, authorityPath: identity.authorityPath };
}

function normalizeOutput(value) {
  return {
    stdout: String(value?.stdout ?? ''),
    stderr: String(value?.stderr ?? ''),
  };
}

function runnerIdentity(child, command) {
  const wrapperProgram = typeof child?.wrapperProgram === 'string' ? child.wrapperProgram : null;
  const wrapperArgs = Array.isArray(child?.wrapperArgs) && child.wrapperArgs.every(arg => typeof arg === 'string')
    ? child.wrapperArgs
    : [];
  return {
    logicalCommand: typeof child?.logicalCommand === 'string' && child.logicalCommand ? child.logicalCommand : command,
    resolvedExecutable: typeof child?.resolvedExecutable === 'string' && child.resolvedExecutable ? child.resolvedExecutable : command,
    wrapperKind: ['native', 'unresolved', 'windows_cmd_shim', 'powershell_script'].includes(child?.wrapperKind)
      ? child.wrapperKind
      : 'native',
    wrapperProgram,
    wrapperArgs: [...wrapperArgs],
  };
}

function validSha256(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function validPacketDigest(value) {
  return /^sha256:agenticloop\.role-preparation\.v\d+:[0-9a-f]{64}$/.test(value);
}

function validContractDigest(value) {
  return /^sha256:v1:[0-9a-f]{64}$/.test(value);
}

function validGitObjectId(value) {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

/** Validate the closed portable execution-evidence wire shape. */
export function validateExecutionEvidence(value, { expectedBinding = null, ...options } = {}) {
  const errors = [];
  const diagnostics = [];
  if (!exactKeys(value, FIELDS)) return { ok: false, errors: ['execution evidence fields must equal the closed schema'], diagnostics };
  if (value.kind !== EXECUTION_EVIDENCE_KIND || value.schemaVersion !== EXECUTION_EVIDENCE_SCHEMA_VERSION) {
    if (value?.schemaVersion === 2) {
      const stale = new ExecutionEvidenceStaleVersionError();
      errors.push(stale.message);
      diagnostics.push({ code: stale.code, observedVersion: stale.observedVersion, requiredVersion: stale.requiredVersion });
    } else {
      errors.push('execution evidence identity is invalid');
    }
  }
  if (!exactKeys(value.check, ['id', 'instruction', 'command', 'args']) ||
      typeof value.check?.id !== 'string' || !value.check.id ||
      typeof value.check?.instruction !== 'string' || !value.check.instruction ||
      typeof value.check?.command !== 'string' || !value.check.command ||
      !Array.isArray(value.check?.args) || !value.check.args.every(arg => typeof arg === 'string')) {
    errors.push('execution evidence check must preserve exact instruction and argv identity');
  }
  if (!exactKeys(value.runner, ['logicalCommand', 'resolvedExecutable', 'wrapperKind', 'wrapperProgram', 'wrapperArgs']) ||
      value.runner?.logicalCommand !== value.check?.command ||
      typeof value.runner?.resolvedExecutable !== 'string' || !value.runner.resolvedExecutable ||
      !['native', 'unresolved', 'windows_cmd_shim', 'powershell_script'].includes(value.runner?.wrapperKind) ||
      !(value.runner.wrapperProgram === null || (typeof value.runner.wrapperProgram === 'string' && value.runner.wrapperProgram)) ||
      !Array.isArray(value.runner?.wrapperArgs) || !value.runner.wrapperArgs.every(arg => typeof arg === 'string') ||
      ((value.runner.wrapperProgram === null) !== (value.runner.wrapperArgs.length === 0))) {
    errors.push('execution evidence runner must preserve resolved executable and actual wrapper identity');
  }
  if (!exactKeys(value.binding, [
    'packetId', 'packetDigest', 'invocationId', 'taskId',
    'taskContractDigest', 'currentCarrierDigest', 'repositoryHead', 'productHead',
  ]) ||
      typeof value.binding?.packetId !== 'string' || !/^dispatch:[0-9a-f-]{36}$/.test(value.binding.packetId) ||
      typeof value.binding?.packetDigest !== 'string' || !validPacketDigest(value.binding.packetDigest) ||
      typeof value.binding?.invocationId !== 'string' || !value.binding.invocationId ||
      typeof value.binding?.taskId !== 'string' || !value.binding.taskId ||
      typeof value.binding?.taskContractDigest !== 'string' || !validContractDigest(value.binding.taskContractDigest) ||
      typeof value.binding?.currentCarrierDigest !== 'string' || !validSha256(value.binding.currentCarrierDigest) ||
      typeof value.binding?.repositoryHead !== 'string' || !validGitObjectId(value.binding.repositoryHead) ||
      typeof value.binding?.productHead !== 'string' || !validGitObjectId(value.binding.productHead)) {
    errors.push('execution evidence must bind one exact dispatch, task carrier, and repository state');
  }
  if (!exactKeys(value.timing, ['startedAt', 'endedAt', 'monotonicDurationMs']) ||
      !strictUtc(value.timing?.startedAt) || !strictUtc(value.timing?.endedAt) ||
      !Number.isSafeInteger(value.timing?.monotonicDurationMs) || value.timing.monotonicDurationMs < 0 ||
      value.timing.monotonicDurationMs > MAX_MONOTONIC_DURATION_MS) {
    errors.push('execution evidence timing must use strict UTC instants and a bounded monotonic duration');
  }
  if (!exactKeys(value.locations, LOCATION_FIELDS)) {
    errors.push('execution evidence locations must equal the closed schema');
  } else {
    for (const field of LOCATION_FIELDS) {
      const location = value.locations[field];
      if (!exactKeys(location, ['displayPath', 'authorityPath']) ||
          typeof location.displayPath !== 'string' || !location.displayPath ||
          typeof location.authorityPath !== 'string' || !location.authorityPath) {
        errors.push(`execution evidence ${field} path identity is invalid`);
      }
    }
    const scratch = value.locations.projectScratchRoot?.authorityPath;
    const worktree = value.locations.artifactWorktreeRoot?.authorityPath;
    const expectedScratch = `${worktree}/.agenticloop/tmp`;
    if (scratch && worktree && !samePathAuthority(scratch, expectedScratch, { ...options, base: '/' })) {
      errors.push('execution evidence scratch root must be project-owned under artifact worktree .agenticloop/tmp');
    }
  }
  if (!exactKeys(value.execution, ['outcome', 'childExitCode', 'wrapperFailure', 'outputFilterFailure', 'output'])) {
    errors.push('execution evidence execution fields must equal the closed schema');
  } else {
    const execution = value.execution;
    if (!['passed', 'child_failed', 'wrapper_failed', 'output_filter_failed'].includes(execution.outcome) ||
        (execution.childExitCode !== null && !Number.isSafeInteger(execution.childExitCode)) ||
        typeof execution.wrapperFailure !== 'string' && execution.wrapperFailure !== null ||
        typeof execution.outputFilterFailure !== 'string' && execution.outputFilterFailure !== null ||
        !exactKeys(execution.output, ['stdout', 'stderr']) ||
        typeof execution.output.stdout !== 'string' || typeof execution.output.stderr !== 'string') {
      errors.push('execution evidence execution result is invalid');
    } else if ((execution.outcome === 'passed' && execution.childExitCode !== 0) ||
      (execution.outcome === 'child_failed' && (!Number.isSafeInteger(execution.childExitCode) || execution.childExitCode === 0)) ||
      (execution.outcome === 'wrapper_failed' && (execution.childExitCode !== null || execution.wrapperFailure === null || execution.outputFilterFailure !== null)) ||
      (execution.outcome === 'output_filter_failed' && (execution.childExitCode === null || execution.wrapperFailure !== null || execution.outputFilterFailure === null))) {
      errors.push('execution evidence must distinguish child, wrapper, and output-filter failures');
    }
  }
  if (value.digest !== evidenceDigest(value)) errors.push('execution evidence digest is invalid');
  if (expectedBinding !== null && JSON.stringify(value.binding) !== JSON.stringify(expectedBinding)) {
    errors.push('execution evidence does not match the expected dispatch binding');
  }
  return { ok: errors.length === 0, errors, diagnostics };
}

/**
 * Execute a command through an injected argv runner and produce validated proof.
 * The runner receives `{ command, args, cwd }`; neither instructions nor args
 * are interpreted as shell syntax.
 */
export function produceExecutionEvidence(input = {}, {
  run,
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  outputFilter = output => output,
  pathOptions = {},
} = {}) {
  if (typeof run !== 'function') throw new TypeError('execution evidence requires an injected argv runner');
  const { checkId, instruction, command, args = [], carrierRoot, artifactWorktreeRoot, workingDirectory, projectScratchRoot, binding } = input;
  if (![checkId, instruction, command, carrierRoot, artifactWorktreeRoot, workingDirectory, projectScratchRoot].every(value => typeof value === 'string' && value) || !binding) {
    throw new TypeError('execution evidence requires exact check, dispatch binding, and project location identities');
  }
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new TypeError('execution arguments must be a string array');
  const started = now();
  const monotonicStarted = monotonicNow();
  let childExitCode = null;
  let wrapperFailure = null;
  let outputFilterFailure = null;
  let output = { stdout: '', stderr: '' };
  let runner = { logicalCommand: command, resolvedExecutable: command, wrapperKind: 'native', wrapperProgram: null, wrapperArgs: [] };
  try {
    const child = run({ command, args: [...args], cwd: workingDirectory });
    runner = runnerIdentity(child, command);
    if (!Number.isSafeInteger(child?.exitCode)) throw new TypeError('runner did not report a true child exit code');
    childExitCode = child.exitCode;
    output = normalizeOutput(child);
    try { output = normalizeOutput(outputFilter(output)); } catch (error) { outputFilterFailure = String(error?.message ?? error); }
  } catch (error) {
    // Runners such as the Windows cmd shim attach their attempted wrapper
    // identity to launch errors.  Preserve that evidence rather than replacing
    // it with the logical command's default native identity.
    runner = runnerIdentity(error, command);
    wrapperFailure = String(error?.message ?? error);
  }
  const ended = now();
  const duration = Math.floor(monotonicNow() - monotonicStarted);
  const outcome = wrapperFailure !== null ? 'wrapper_failed' : outputFilterFailure !== null ? 'output_filter_failed' : childExitCode === 0 ? 'passed' : 'child_failed';
  const record = {
    kind: EXECUTION_EVIDENCE_KIND,
    schemaVersion: EXECUTION_EVIDENCE_SCHEMA_VERSION,
    check: { id: checkId, instruction, command, args: [...args] },
    runner,
    binding: { ...binding },
    timing: { startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), monotonicDurationMs: duration },
    locations: Object.fromEntries(LOCATION_FIELDS.map(field => [field, locationRecord(input[field], pathOptions)])),
    execution: { outcome, childExitCode, wrapperFailure, outputFilterFailure, output },
    digest: null,
  };
  record.digest = evidenceDigest(record);
  const checked = validateExecutionEvidence(record, pathOptions);
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return Object.freeze(record);
}
