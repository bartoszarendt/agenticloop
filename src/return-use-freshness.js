/** Versioned policy governing how long a verified return may authorize reuse. */

export const RETURN_USE_FRESHNESS_POLICY_KIND = 'agenticloop.return-use-freshness';
export const RETURN_USE_FRESHNESS_POLICY_SCHEMA_VERSION = 1;
export const RETURN_USE_DEFAULT_MAX_AGE_SECONDS = 86_400;
export const RETURN_USE_FRESHNESS_POLICY = Object.freeze({
  kind: RETURN_USE_FRESHNESS_POLICY_KIND,
  schemaVersion: RETURN_USE_FRESHNESS_POLICY_SCHEMA_VERSION,
  maxAgeSeconds: RETURN_USE_DEFAULT_MAX_AGE_SECONDS,
});

/** Closed validation: absent, old, future, and extended policies are unusable. */
export function validateReturnUseFreshnessPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).length !== 3 || Object.keys(policy).some(key => !['kind', 'schemaVersion', 'maxAgeSeconds'].includes(key))) {
    return { ok: false, errors: ['return-use freshness policy must equal the closed schema'] };
  }
  if (policy.kind !== RETURN_USE_FRESHNESS_POLICY_KIND) errors.push(`return-use freshness policy kind must be '${RETURN_USE_FRESHNESS_POLICY_KIND}'`);
  if (policy.schemaVersion !== RETURN_USE_FRESHNESS_POLICY_SCHEMA_VERSION) errors.push(`return-use freshness policy schemaVersion must be ${RETURN_USE_FRESHNESS_POLICY_SCHEMA_VERSION}`);
  if (policy.maxAgeSeconds !== RETURN_USE_DEFAULT_MAX_AGE_SECONDS) errors.push(`return-use freshness policy maxAgeSeconds must be ${RETURN_USE_DEFAULT_MAX_AGE_SECONDS}`);
  return { ok: errors.length === 0, errors };
}

/** Resolve the only supported project configuration surface. */
export function resolveReturnUseFreshnessPolicy(projectConfig = {}) {
  if (!projectConfig || typeof projectConfig !== 'object' || Array.isArray(projectConfig)) {
    return { ok: false, policy: null, errors: ['return-use freshness configuration must be an object'] };
  }
  // Omitted configuration means the stable v1 default. A declared value must
  // be a complete current policy; partial, old, and future configurations fail.
  if (!Object.hasOwn(projectConfig, 'return_use_freshness')) {
    return { ok: true, policy: RETURN_USE_FRESHNESS_POLICY, errors: [] };
  }
  const checked = validateReturnUseFreshnessPolicy(projectConfig.return_use_freshness);
  return checked.ok
    ? { ok: true, policy: Object.freeze({ ...projectConfig.return_use_freshness }), errors: [] }
    : { ok: false, policy: null, errors: checked.errors };
}
