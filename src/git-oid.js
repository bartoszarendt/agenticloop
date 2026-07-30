/**
 * One canonical full Git object-identity rule.
 *
 * Task evidence and base resolution already accept SHA-1 (40 hex) and SHA-256
 * (64 hex) repositories. Every dispatch-envelope, commit-range, and
 * committed-source check must consume this single definition so the two object
 * formats cannot drift back into parallel, divergent regexes. Abbreviated
 * identities are never accepted: an evidence identity is either the complete
 * lowercase hex object id or it is malformed.
 */

/** Full lowercase SHA-1 (40) or SHA-256 (64) Git object identity. */
export const GIT_OBJECT_ID_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Prefixed Git tree identity (`git-tree:<full object id>`). */
export const GIT_TREE_IDENTITY_RE = /^git-tree:([a-f0-9]{40}(?:[a-f0-9]{24})?)$/;

/**
 * True when `value` is a complete lowercase 40- or 64-character Git object
 * identity. Abbreviations, uppercase, and other lengths are rejected.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isGitObjectId(value) {
  return typeof value === 'string' && GIT_OBJECT_ID_RE.test(value);
}

/**
 * Extract the full object identity from a `git-tree:` identity, or null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function gitTreeObjectId(value) {
  if (typeof value !== 'string') return null;
  return value.match(GIT_TREE_IDENTITY_RE)?.[1] ?? null;
}

/**
 * Name the object format a full Git identity belongs to, or null when the value
 * is not a complete identity. Length is the only discriminator Git exposes in a
 * bare object id, so 40 hex is SHA-1 and 64 hex is SHA-256.
 *
 * @param {unknown} value
 * @returns {'sha1'|'sha256'|null}
 */
export function gitObjectFormat(value) {
  if (!isGitObjectId(value)) return null;
  return value.length === 40 ? 'sha1' : 'sha256';
}

/**
 * Prove that a collection of identities describes one repository: every value is
 * a complete lowercase identity and they all share a single object format.
 *
 * One repository has exactly one object format. A mixed 40/64 collection cannot
 * describe one repository's durable state, so it is rejected rather than
 * resolved - accepting it would let a caller splice identities from two
 * repositories into one evidence claim. Absent values are not supplied
 * identities and are skipped; per-field presence and completeness stay the
 * caller's own checks so a missing field and a mixed format remain distinct
 * diagnostics.
 *
 * @param {Iterable<unknown>} values
 * @returns {boolean}
 */
export function sameGitObjectFormat(values) {
  const formats = new Set();
  for (const value of values ?? []) {
    if (value === null || value === undefined) continue;
    const format = gitObjectFormat(value);
    if (format === null) return false;
    formats.add(format);
    if (formats.size > 1) return false;
  }
  return true;
}
