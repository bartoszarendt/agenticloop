/**
 * Deterministic canonical JSON serialization and SHA-256 digests.
 *
 * The closeout provenance projection must produce byte-identical input across
 * Windows and POSIX hosts, supported Node versions, path separators, line
 * endings, and JSON object insertion orders. Canonicalization is RFC 8785-style:
 * object keys are recursively ordered, strings are emitted with JSON escaping,
 * and numbers use the shortest ECMAScript representation. Only the value types
 * the closeout packet schema permits (null, boolean, finite number, string,
 * array, plain object) are accepted; anything else fails closed.
 */

import { createHash } from 'node:crypto';

function assertCanonicalizable(value, path) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonical JSON cannot represent a non-finite number at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalizable(item, `${path}[${index}]`));
    return;
  }
  if (type === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertCanonicalizable(item, path ? `${path}.${key}` : key);
    }
    return;
  }
  throw new Error(`canonical JSON cannot represent ${type} at ${path || '(root)'}`);
}

function serialize(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    // JSON.stringify uses the shortest round-trip representation for finite
    // doubles and normalizes -0 to 0; both are stable across Node versions.
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(value[key])}`).join(',')}}`;
}

/**
 * Serialize a value to deterministic canonical UTF-8 JSON. Object key order is
 * recursively sorted; array order is preserved (set-like arrays must be sorted
 * by the schema before serialization).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  assertCanonicalizable(value, '');
  return serialize(value);
}

/**
 * SHA-256 hex digest of the canonical UTF-8 serialization of `value`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalSha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf-8').digest('hex');
}
