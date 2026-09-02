import { canonicalSha256 } from './canonical-json.js';

/**
 * Derive the immutable execution-attempt identity from the dispatch
 * consumption that started it.
 */
export function executionAttemptIdentity(consumption) {
  if (!consumption?.packetId || !consumption?.invocationId || !consumption?.productBaseHead) {
    throw new TypeError('an execution attempt identity requires packetId, invocationId, and productBaseHead');
  }
  const digest = canonicalSha256({
    packetId: consumption.packetId,
    packetDigest: consumption.packetDigest,
    invocationId: consumption.invocationId,
    productBaseHead: consumption.productBaseHead,
    taskId: consumption.taskId,
  });
  return `attempt:${digest.slice(0, 32)}`;
}
