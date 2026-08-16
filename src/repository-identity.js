/**
 * Versioned repository authority identity.
 *
 * Operator-owned state that lives outside a target repository - the activation
 * confirmation key, the host trust store, external revocation tombstones - is
 * addressed by a digest of the target's canonical authority identity. Changing
 * how that identity is derived therefore relocates every existing record, so
 * the derivation is versioned and its superseded spellings stay discoverable.
 *
 * v1 built `file:` + the host's resolved path with separators normalized and
 * the host's letter case preserved.
 * v2 (current) adds Windows case folding, so one checkout addressed as
 * `C:\Apps\Repo` and `c:\apps\repo` resolves to one identity.
 *
 * On POSIX the two versions agree, so `legacyRepositoryAuthorityIdentities`
 * returns an empty list and every migration path is a documented no-op.
 */

import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';

import { filePathIdentity, pathIdentity } from './path-identity.js';

export const REPOSITORY_AUTHORITY_IDENTITY_VERSION = 2;
export const LEGACY_REPOSITORY_AUTHORITY_IDENTITY_VERSION = 1;

/** The current canonical authority identity for one target repository. */
export function repositoryAuthorityIdentity(target, options = {}) {
  return filePathIdentity(String(target ?? '.'), options);
}

/** The per-repository addressing digest used by operator-owned storage. */
export function repositoryAuthorityDigest(identity) {
  return createHash('sha256').update(String(identity ?? ''), 'utf8').digest('hex');
}

/**
 * Every superseded spelling under which this target's operator state may
 * already exist, newest derivation rules first excluded.
 *
 * The candidate set is deliberately small and closed: the realpath spelling and
 * the lexically resolved spelling, each with both drive-letter cases. It never
 * enumerates arbitrary case permutations of interior segments, because a v1
 * record could only ever have been written under a spelling the host itself
 * produced.
 */
export function legacyRepositoryAuthorityIdentities(target, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return [];
  const current = repositoryAuthorityIdentity(target, options);
  const exists = options.exists ?? existsSync;
  const realpath = options.realpath ?? (realpathSync.native ?? realpathSync);
  const display = pathIdentity(target, options).displayPath;
  let native = display;
  try {
    if (exists(display)) native = realpath(display);
  } catch {
    // An unresolvable path has no realpath spelling to migrate from; the
    // lexical spelling below is still a legitimate v1 candidate.
  }
  const spellings = new Set();
  for (const raw of [native, display]) {
    const slashed = String(raw).replace(/\\/g, '/');
    if (!slashed) continue;
    spellings.add(slashed);
    if (/^[A-Za-z]:/.test(slashed)) {
      spellings.add(`${slashed[0].toUpperCase()}${slashed.slice(1)}`);
      spellings.add(`${slashed[0].toLowerCase()}${slashed.slice(1)}`);
    }
  }
  return [...spellings]
    .map(spelling => `file:${spelling}`)
    .filter(identity => identity !== current)
    .sort();
}
