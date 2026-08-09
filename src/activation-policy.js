/**
 * Effective activation and return assurance policy.
 *
 * Two independent dimensions are graded, and one overall mode makes the common
 * cases usable:
 *
 *   standard   minimum activation `operator_confirmed`; return may be
 *              `session_reported`.
 *   hardened   activation must be `host_signed`; return must carry a
 *              `host_receipt`.
 *
 * Policy comes from two sources with a deliberate asymmetry:
 *
 * - An **operator pin** held outside the target repository, beside the operator
 *   activation material. Nothing inside the repository can lower it.
 * - The target's own `agenticloop.json`, which may only *raise* the minimum.
 *
 * That asymmetry is the whole point: `agenticloop.json` is model-writable, so a
 * hardened requirement can never rest on it alone, and an agent editing target
 * configuration can never relax an operator's pinned floor.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  ACTIVATION_ASSURANCE_ORDER,
  RETURN_ASSURANCE_ORDER,
  activationAssuranceMeets,
  compareActivationAssurance,
  compareReturnAssurance,
  returnAssuranceMeets,
} from './activation-grant.js';
import { defaultOperatorActivationRoot } from './activation-trust.js';
import { targetRepositoryIdentity } from './host-trust.js';

export const ACTIVATION_POLICY_KIND = 'agenticloop.activation-policy-pin';
export const ACTIVATION_POLICY_SCHEMA_VERSION = 1;
export const ACTIVATION_MODES = Object.freeze(['standard', 'hardened']);

/** The floor every mode enforces before any configuration is consulted. */
export const MODE_MINIMUMS = Object.freeze({
  standard: Object.freeze({ activation: 'operator_confirmed', return: 'session_reported' }),
  hardened: Object.freeze({ activation: 'host_signed', return: 'host_receipt' }),
});

const POLICY_FIELDS = Object.freeze(['kind', 'schemaVersion', 'target', 'mode']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalPath(path) {
  const resolved = resolve(String(path));
  if (!existsSync(resolved)) return resolved;
  const nativeRealpath = realpathSync.native ?? realpathSync;
  return nativeRealpath(resolved);
}

function outsideTarget(target, path) {
  const fromTarget = relative(canonicalPath(target), canonicalPath(path));
  return Boolean(fromTarget) && (fromTarget.startsWith('..') || isAbsolute(fromTarget));
}

/** Resolve the only operator activation-policy pin path permitted for a target. */
export function activationPolicyPinPath(target, root = defaultOperatorActivationRoot()) {
  const digest = createHash('sha256').update(targetRepositoryIdentity(target), 'utf8').digest('hex');
  return join(canonicalPath(root), `${digest}.policy.json`);
}

/**
 * Read the external operator policy pin.
 *
 * A malformed, mismatched, or inside-the-target pin fails closed: the caller
 * gets `ok: false` and must refuse rather than silently fall back to the
 * permissive default.
 */
export function loadActivationPolicyPin(target, options = {}) {
  const configuredRoot = options.operatorActivationRoot ?? defaultOperatorActivationRoot();
  if (typeof configuredRoot !== 'string' || !configuredRoot.trim() || !isAbsolute(configuredRoot)) {
    return { ok: false, state: 'malformed', mode: null, errors: ['operator activation root must be an absolute path'], path: null };
  }
  if (!outsideTarget(target, configuredRoot)) {
    return { ok: false, state: 'malformed', mode: null, errors: ['operator activation root must be outside the target repository'], path: null };
  }
  const path = activationPolicyPinPath(target, configuredRoot);
  if (!existsSync(path)) return { ok: true, state: 'absent', mode: null, errors: [], path };
  if (lstatSync(path).isSymbolicLink()) {
    return { ok: false, state: 'malformed', mode: null, errors: ['operator activation policy pin must not be a symbolic link'], path };
  }
  const realPath = canonicalPath(path);
  if (!outsideTarget(target, realPath)) {
    return { ok: false, state: 'malformed', mode: null, errors: ['operator activation policy pin resolves inside the target repository'], path: realPath };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(realPath, 'utf8'));
  } catch (error) {
    return { ok: false, state: 'malformed', mode: null, errors: [`operator activation policy pin is unreadable or invalid JSON: ${error.message}`], path: realPath };
  }
  /** @type {string[]} */
  const errors = [];
  if (!isObject(parsed)) {
    return { ok: false, state: 'malformed', mode: null, errors: ['operator activation policy pin must be a JSON object'], path: realPath };
  }
  const missing = POLICY_FIELDS.filter(field => !Object.hasOwn(parsed, field));
  const unknown = Object.keys(parsed).filter(field => !POLICY_FIELDS.includes(field));
  if (missing.length) errors.push(`operator activation policy pin is missing field(s): ${missing.join(', ')}`);
  if (unknown.length) errors.push(`operator activation policy pin contains unknown field(s): ${unknown.join(', ')}`);
  if (parsed.kind !== ACTIVATION_POLICY_KIND) errors.push(`operator activation policy pin kind must be '${ACTIVATION_POLICY_KIND}'`);
  if (parsed.schemaVersion !== ACTIVATION_POLICY_SCHEMA_VERSION) {
    errors.push(`operator activation policy pin schemaVersion must be ${ACTIVATION_POLICY_SCHEMA_VERSION}`);
  }
  const expected = targetRepositoryIdentity(target);
  if (!isObject(parsed.target) || Object.keys(parsed.target).length !== 1 ||
      typeof parsed.target.repositoryIdentity !== 'string') {
    errors.push('operator activation policy pin target must contain exactly repositoryIdentity');
  } else if (parsed.target.repositoryIdentity !== expected) {
    errors.push('operator activation policy pin target does not match this repository');
  }
  if (!ACTIVATION_MODES.includes(parsed.mode)) {
    errors.push(`operator activation policy pin mode must be one of: ${ACTIVATION_MODES.join(', ')}`);
  }
  if (errors.length) return { ok: false, state: 'malformed', mode: null, errors, path: realPath };
  return { ok: true, state: 'pinned', mode: parsed.mode, errors: [], path: realPath };
}

/**
 * Read the target's requested activation mode from `agenticloop.json`.
 * An absent block means "no repository request"; a malformed one fails closed.
 */
export function readProjectActivationRequest(config) {
  const requested = config?.activation;
  if (requested === undefined || requested === null) {
    return { ok: true, mode: null, errors: [] };
  }
  if (!isObject(requested)) {
    return { ok: false, mode: null, errors: ['agenticloop.json activation must be an object'] };
  }
  const unknown = Object.keys(requested).filter(key => key !== 'mode');
  if (unknown.length) {
    return { ok: false, mode: null, errors: [`agenticloop.json activation contains unknown field(s): ${unknown.join(', ')}`] };
  }
  if (!ACTIVATION_MODES.includes(requested.mode)) {
    return { ok: false, mode: null, errors: [`agenticloop.json activation mode must be one of: ${ACTIVATION_MODES.join(', ')}`] };
  }
  return { ok: true, mode: requested.mode, errors: [] };
}

/**
 * Resolve the effective activation and return minimums for one target.
 *
 * @param {{
 *   target: string,
 *   projectConfig?: object|null,
 *   operatorActivationRoot?: string|null,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   mode: string,
 *   minimumActivation: string,
 *   minimumReturn: string,
 *   source: string,
 *   pinnedMode: string|null,
 *   requestedMode: string|null,
 *   errors: string[],
 * }}
 */
export function resolveActivationPolicy(input = {}) {
  const pin = loadActivationPolicyPin(input.target, {
    operatorActivationRoot: input.operatorActivationRoot ?? undefined,
  });
  const requested = readProjectActivationRequest(input.projectConfig ?? null);
  const errors = [...pin.errors, ...requested.errors];
  if (errors.length) {
    // Fail closed at the strongest setting so a malformed policy can never be
    // the reason a weaker grade was accepted.
    return {
      ok: false,
      mode: 'hardened',
      minimumActivation: MODE_MINIMUMS.hardened.activation,
      minimumReturn: MODE_MINIMUMS.hardened.return,
      source: 'unresolved',
      pinnedMode: null,
      requestedMode: null,
      errors,
    };
  }
  const pinnedMode = pin.mode;
  const requestedMode = requested.mode;
  // The repository may raise the bar; it can never lower an operator pin.
  const effective = strongerMode(pinnedMode ?? 'standard', requestedMode ?? 'standard');
  const source = pinnedMode && requestedMode
    ? (effective === pinnedMode && effective !== requestedMode ? 'operator_pin' : 'operator_pin+repository')
    : pinnedMode
      ? 'operator_pin'
      : requestedMode
        ? 'repository'
        : 'default';
  return {
    ok: true,
    mode: effective,
    minimumActivation: MODE_MINIMUMS[effective].activation,
    minimumReturn: MODE_MINIMUMS[effective].return,
    source,
    pinnedMode: pinnedMode ?? null,
    requestedMode: requestedMode ?? null,
    errors: [],
  };
}

function strongerMode(left, right) {
  return ACTIVATION_MODES.indexOf(left) >= ACTIVATION_MODES.indexOf(right) ? left : right;
}

/**
 * Evaluate one observed activation grade against a resolved policy.
 * `null` means no activation record at all: scaffold state, always blocked.
 */
export function evaluateActivationAgainstPolicy(observed, policy) {
  if (observed === null || observed === undefined) {
    return {
      ok: false,
      evidenceState: 'missing',
      disposition: 'needs_context',
      message:
        'This task carries no activation authority. Run `npx agenticloop activate ' +
        '<task-id>` in an interactive terminal, or supply a host-signed activation capture.',
    };
  }
  if (!activationAssuranceMeets(observed, policy.minimumActivation)) {
    return {
      ok: false,
      evidenceState: 'negative',
      disposition: 'blocked',
      message:
        `activation assurance '${String(observed)}' is below the effective minimum ` +
        `'${policy.minimumActivation}' required by ${policy.mode} mode (policy source: ${policy.source})`,
    };
  }
  return { ok: true, evidenceState: 'current', disposition: 'proceed', message: null };
}

/** Evaluate one observed return grade against a resolved policy. */
export function evaluateReturnAgainstPolicy(observed, policy) {
  if (!returnAssuranceMeets(observed, policy.minimumReturn)) {
    return {
      ok: false,
      evidenceState: 'negative',
      disposition: 'blocked',
      message:
        `return assurance '${String(observed)}' is below the effective minimum ` +
        `'${policy.minimumReturn}' required by ${policy.mode} mode (policy source: ${policy.source})`,
    };
  }
  return { ok: true, evidenceState: 'current', disposition: 'proceed', message: null };
}

export {
  ACTIVATION_ASSURANCE_ORDER,
  RETURN_ASSURANCE_ORDER,
  activationAssuranceMeets,
  compareActivationAssurance,
  compareReturnAssurance,
  returnAssuranceMeets,
};
