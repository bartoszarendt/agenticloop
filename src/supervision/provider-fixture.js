/**
 * Opt-in provider-backed acceptance fixture contract.
 *
 * The provider scenario spends real money against a real model, so it is gated
 * on an explicit, disposable, marked fixture rather than on ambient credentials.
 * Validation lives here (not in the smoke script) so the gate itself can be
 * tested exhaustively without ever invoking a provider.
 *
 * This module deliberately never reads a credential *value*. It only checks
 * that the operator asserted credentials are configured.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const PROVIDER_FIXTURE_MARKER = '.agenticloop-provider-fixture.json';
export const PROVIDER_FIXTURE_PURPOSE = 'agenticloop-opencode-provider-smoke';
export const MINIMUM_TIMEOUT_MS = 30_000;
export const MAXIMUM_TIMEOUT_MS = 10 * 60_000;

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function skip(reason) {
  return { enabled: false, reason };
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ repoRoot: string, home?: string, workspaceRoots?: string[] }} context
 */
export function validateProviderFixture(env = {}, context = {}) {
  if (env.AGENTICLOOP_OPENCODE_PROVIDER_SMOKE !== '1') {
    return skip('AGENTICLOOP_OPENCODE_PROVIDER_SMOKE is not set to 1');
  }

  const rawTarget = env.AGENTICLOOP_OPENCODE_PROVIDER_TARGET;
  if (!rawTarget || !rawTarget.trim()) return skip('AGENTICLOOP_OPENCODE_PROVIDER_TARGET is required and must name a disposable fixture directory');
  const target = resolve(rawTarget.trim());

  const model = (env.AGENTICLOOP_OPENCODE_PROVIDER_MODEL ?? '').trim();
  if (!model) return skip('AGENTICLOOP_OPENCODE_PROVIDER_MODEL is required; the provider scenario never guesses a model');
  if (!/^[\w.-]+\/[\w./-]+$/.test(model)) return skip('AGENTICLOOP_OPENCODE_PROVIDER_MODEL must be an explicit provider/model route');

  if (env.AGENTICLOOP_OPENCODE_PROVIDER_COST_ACK !== 'yes') {
    return skip('AGENTICLOOP_OPENCODE_PROVIDER_COST_ACK must be exactly "yes"; this scenario spends real provider budget');
  }
  // Presence acknowledgement only. The value of a credential is never read.
  if (env.AGENTICLOOP_OPENCODE_PROVIDER_CREDENTIALS_ACK !== 'yes') {
    return skip('AGENTICLOOP_OPENCODE_PROVIDER_CREDENTIALS_ACK must be exactly "yes" to confirm the host already has provider credentials configured');
  }

  const timeout = Number(env.AGENTICLOOP_OPENCODE_PROVIDER_TIMEOUT_MS ?? NaN);
  if (!Number.isFinite(timeout) || timeout < MINIMUM_TIMEOUT_MS || timeout > MAXIMUM_TIMEOUT_MS) {
    return skip(`AGENTICLOOP_OPENCODE_PROVIDER_TIMEOUT_MS must be between ${MINIMUM_TIMEOUT_MS} and ${MAXIMUM_TIMEOUT_MS}`);
  }

  const repoRoot = context.repoRoot ? resolve(context.repoRoot) : null;
  const home = resolve(context.home ?? homedir());
  // Writing anywhere inside the repository or a configured workspace is refused
  // outright. The home directory is refused only as an exact target or as a
  // directory the fixture would contain: an ordinary disposable fixture (and,
  // on Windows, the whole temp tree) legitimately lives somewhere under it.
  const containmentForbidden = [
    ...(repoRoot ? [['the Agentic Loop repository root', repoRoot]] : []),
    ...(context.workspaceRoots ?? []).map(root => ['a configured workspace root', resolve(root)]),
  ];
  for (const [label, root] of containmentForbidden) {
    if (target === root || isWithin(root, target)) {
      return skip(`the provider fixture target must not be ${label} or inside it: ${target}`);
    }
    if (isWithin(target, root)) {
      return skip(`the provider fixture target must not contain ${label}: ${target}`);
    }
  }
  if (target === home) return skip(`the provider fixture target must not be the operator home directory: ${target}`);
  if (isWithin(target, home)) return skip(`the provider fixture target must not contain the operator home directory: ${target}`);

  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return skip(`the provider fixture target does not exist as a directory: ${target}`);
  }

  const markerPath = join(target, PROVIDER_FIXTURE_MARKER);
  if (!existsSync(markerPath)) {
    return skip(`the provider fixture target has no ${PROVIDER_FIXTURE_MARKER} disposability marker`);
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (error) {
    return skip(`${PROVIDER_FIXTURE_MARKER} is not valid JSON: ${error.message}`);
  }
  if (marker?.disposable !== true || marker?.purpose !== PROVIDER_FIXTURE_PURPOSE) {
    return skip(`${PROVIDER_FIXTURE_MARKER} must contain {"disposable": true, "purpose": "${PROVIDER_FIXTURE_PURPOSE}"}`);
  }

  return {
    enabled: true,
    fixture: {
      target,
      model,
      timeout_ms: Math.round(timeout),
      marker_path: markerPath,
      // Recorded so the report can prove the acknowledgements were explicit,
      // without recording anything about the credentials themselves.
      cost_acknowledged: true,
      credentials_acknowledged: true,
    },
  };
}

/**
 * Build the sanitized provider report. Identities, classifications, generations,
 * actions, timings, and artifact references only -- never prompts, model
 * responses, credentials, or private reasoning.
 */
export function buildProviderReport({ fixture, host, scenario, steps }) {
  return {
    report_version: 1,
    generated_at: new Date().toISOString(),
    host: {
      binary: host.binary,
      opencode_version: host.version,
      supported_range: host.supported_range,
    },
    fixture: {
      target: fixture.target,
      model_route: fixture.model,
      timeout_ms: fixture.timeout_ms,
      cost_acknowledged: fixture.cost_acknowledged,
      credentials_acknowledged: fixture.credentials_acknowledged,
    },
    scenario,
    steps: steps.map(step => ({
      name: step.name,
      ok: step.ok === true,
      detail: step.detail ?? null,
      duration_ms: Number.isFinite(step.duration_ms) ? Math.round(step.duration_ms) : null,
    })),
  };
}
