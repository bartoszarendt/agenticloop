/** Host-neutral cancellation proof: host terminal state is never authority. */

import { canonicalSha256 } from './canonical-json.js';

export const CANCELLATION_PROVENANCE_KIND = 'agenticloop.cancellation-provenance';
export const CANCELLATION_PROVENANCE_SCHEMA_VERSION = 1;

const FIELDS = ['kind', 'schemaVersion', 'invocation', 'request', 'observation', 'digest'];
const UUID = /^invocation:[0-9a-f-]{36}$/;
const REQUEST = /^cancellation-request:[0-9a-f-]{36}$/;

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
}
function strictUtc(value) { const parsed = Date.parse(value); return typeof value === 'string' && Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function digest(value) { const { digest: ignored, ...unsigned } = value; return `sha256:agenticloop.cancellation-provenance.v1:${canonicalSha256(unsigned)}`; }

/** Parse the closed, unauthenticated cancellation-claim grammar. */
export function validateCancellationProvenance(value) {
  const errors = [];
  if (!exactKeys(value, FIELDS)) return { ok: false, errors: ['cancellation provenance fields must equal the closed schema'] };
  if (value.kind !== CANCELLATION_PROVENANCE_KIND || value.schemaVersion !== CANCELLATION_PROVENANCE_SCHEMA_VERSION) errors.push('cancellation provenance identity is invalid');
  if (!exactKeys(value.invocation, ['controller', 'invocationId', 'command', 'args']) || value.invocation?.controller !== 'agenticloop' || !UUID.test(value.invocation?.invocationId ?? '') || typeof value.invocation?.command !== 'string' || !value.invocation.command || !Array.isArray(value.invocation?.args) || !value.invocation.args.every(arg => typeof arg === 'string')) errors.push('cancellation provenance requires one exact Agentic Loop invocation');
  if (!exactKeys(value.request, ['authority', 'requestId', 'invocationId', 'requestedAt']) || value.request?.authority !== 'agenticloop' || !REQUEST.test(value.request?.requestId ?? '') || value.request?.invocationId !== value.invocation?.invocationId || !strictUtc(value.request?.requestedAt)) errors.push('cancellation provenance requires an Agentic Loop-controlled exact request');
  if (!exactKeys(value.observation, ['observer', 'requestId', 'invocationId', 'observedAt', 'state']) || value.observation?.observer !== 'agenticloop' || value.observation?.requestId !== value.request?.requestId || value.observation?.invocationId !== value.invocation?.invocationId || value.observation?.state !== 'observed' || !strictUtc(value.observation?.observedAt)) errors.push('cancellation provenance requires direct observation of that exact request');
  if (strictUtc(value.request?.requestedAt) && strictUtc(value.observation?.observedAt) &&
      Date.parse(value.observation.observedAt) < Date.parse(value.request.requestedAt)) {
    errors.push('cancellation observation cannot precede the request it observes');
  }
  if (value.digest !== digest(value)) errors.push('cancellation provenance digest is invalid');
  return { ok: errors.length === 0, errors };
}

/**
 * Positive cancellation authority is deliberately unavailable until a
 * protected host integration supplies a pinned, replay-resistant receipt.
 * The public structural builder below cannot be promoted into that authority.
 */
export function validateAuthoritativeCancellationProvenance(value) {
  const structural = validateCancellationProvenance(value);
  if (!structural.ok) return structural;
  return {
    ok: false,
    errors: [
      'positive cancellation authority is unavailable: no protected Agentic Loop cancellation receipt producer is configured',
    ],
  };
}

export function createCancellationProvenance(input = {}) {
  const record = {
    kind: CANCELLATION_PROVENANCE_KIND,
    schemaVersion: CANCELLATION_PROVENANCE_SCHEMA_VERSION,
    invocation: input.invocation,
    request: input.request,
    observation: input.observation,
    digest: null,
  };
  record.digest = digest(record);
  const checked = validateCancellationProvenance(record);
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return Object.freeze(record);
}
