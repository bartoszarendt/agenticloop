/**
 * Canonical trusted-actor configuration for task-contract carriers.
 *
 * One canonical project-map field, `trusted_task_contract_actors`, configures
 * the GitHub logins whose immutable, trusted-association carriers may promote
 * task-contract records. The legacy `github_trusted_actors` alias is honored
 * everywhere with a deprecation warning; without any allowlist, repository
 * OWNER, MEMBER, and COLLABORATOR associations remain trusted with an
 * explicit warning.
 */

export const TRUSTED_ACTORS_FIELD = 'trusted_task_contract_actors';
export const TRUSTED_ACTORS_DEPRECATED_ALIAS = 'github_trusted_actors';

// GitHub logins: alphanumeric or single hyphens, never leading/trailing
// hyphen, at most 39 characters. Compared case-insensitively; the configured
// casing is preserved as the canonical display value.
const GITHUB_LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

/**
 * Resolve and validate the configured trusted-actor allowlist.
 *
 * @returns {{ actors: string[]|null, source: string|null, errors: string[], warnings: string[] }}
 *   `actors` is null when no allowlist is configured (association-only trust)
 *   or when the configuration is invalid; `errors` is non-empty in the
 *   invalid case and callers must fail closed.
 */
export function resolveTrustedTaskContractActors(projectMapConfig) {
  const warnings = [];
  const errors = [];
  const canonical = projectMapConfig?.[TRUSTED_ACTORS_FIELD];
  const alias = projectMapConfig?.[TRUSTED_ACTORS_DEPRECATED_ALIAS];
  let configured = canonical;
  let source = canonical === undefined ? null : TRUSTED_ACTORS_FIELD;
  if (alias !== undefined) {
    warnings.push(`project-map field '${TRUSTED_ACTORS_DEPRECATED_ALIAS}' is deprecated; use '${TRUSTED_ACTORS_FIELD}'`);
    if (canonical === undefined) {
      configured = alias;
      source = TRUSTED_ACTORS_DEPRECATED_ALIAS;
    }
  }
  if (configured === undefined || configured === null) {
    // Compatibility trust: without an allowlist, repository OWNER, MEMBER,
    // and COLLABORATOR associations remain trusted.
    warnings.push(
      `project-map field '${TRUSTED_ACTORS_FIELD}' is not configured; ` +
      'repository OWNER, MEMBER, and COLLABORATOR associations remain trusted for compatibility'
    );
    return { actors: null, source: null, errors, warnings };
  }
  if (!Array.isArray(configured) || configured.length === 0) {
    errors.push(`project-map field '${source}' must be a non-empty list of GitHub logins when present`);
    return { actors: null, source, errors, warnings };
  }
  const seen = new Set();
  const actors = [];
  for (const entry of configured) {
    const login = typeof entry === 'string' ? entry.trim() : '';
    if (!login) {
      errors.push(`project-map field '${source}' contains an empty entry`);
      continue;
    }
    if (!GITHUB_LOGIN_RE.test(login)) {
      errors.push(`project-map field '${source}' contains invalid GitHub login '${login}'`);
      continue;
    }
    const key = login.toLowerCase();
    if (seen.has(key)) {
      errors.push(`project-map field '${source}' contains duplicate login '${login}' (comparison is case-insensitive)`);
      continue;
    }
    seen.add(key);
    actors.push(login);
  }
  if (errors.length) return { actors: null, source, errors, warnings };
  return { actors, source, errors, warnings };
}

/** Case-insensitive membership test against a resolved allowlist. */
export function trustedActorAllowed(actors, login) {
  if (!Array.isArray(actors) || actors.length === 0) return true;
  const key = String(login ?? '').trim().toLowerCase();
  return actors.some(actor => String(actor).toLowerCase() === key);
}
