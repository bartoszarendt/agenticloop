/**
 * Target-owned adapter role-setting defaults used during explicit setup.
 *
 * Keep concrete model choices out of canonical role Markdown and base config.
 */

const ADAPTER_ROLE_DEFAULTS = Object.freeze({
  codex: Object.freeze({
    orchestrator: Object.freeze({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
    }),
    maintainer: Object.freeze({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    }),
    engineer: Object.freeze({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
    }),
    // Auditor gets its own explicit slot. The Maintainer model is never copied
    // in implicitly; a target that wants a different auditor model overrides it
    // through `configure models --role auditor`.
    auditor: Object.freeze({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    }),
  }),
});

/**
 * Return a mutable copy of a host's setup defaults.
 *
 * @param {string} host
 * @returns {Record<string, Record<string, string>>}
 */
export function getDefaultRoleSettings(host) {
  const defaults = ADAPTER_ROLE_DEFAULTS[host] ?? {};
  return Object.fromEntries(
    Object.entries(defaults).map(([role, settings]) => [role, { ...settings }])
  );
}

/**
 * Fill only absent default fields in a target-owned adapter configuration.
 *
 * @param {object} config
 * @param {string} host
 * @returns {{added: string[], kept: string[]}}
 */
export function ensureAdapterRoleSettings(config, host) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('agenticloop.json must contain a JSON object');
  }

  const defaults = getDefaultRoleSettings(host);
  const added = [];
  const kept = [];
  if (Object.keys(defaults).length === 0) return { added, kept };

  config.adapters ??= {};
  config.adapters[host] ??= {};
  config.adapters[host].roleSettings ??= {};

  for (const [role, defaultSettings] of Object.entries(defaults)) {
    const roleSettings = config.adapters[host].roleSettings[role] ??= {};
    for (const [field, value] of Object.entries(defaultSettings)) {
      const path = `adapters.${host}.roleSettings.${role}.${field}`;
      if (Object.hasOwn(roleSettings, field)) {
        kept.push(path);
      } else {
        roleSettings[field] = value;
        added.push(path);
      }
    }
  }

  return { added, kept };
}

/**
 * Reconcile a target-owned adapter configuration against the current
 * canonical role set. Non-destructive and idempotent:
 *
 *   - validates that the target config is a JSON object;
 *   - ensures each selected adapter block exists;
 *   - ensures adapters.<host>.roleSettings exists;
 *   - ensures an explicit target-owned role slot exists for every current
 *     canonical role (added as {} so no canonical role definition is
 *     duplicated into target-owned config);
 *   - preserves every existing user setting and unknown target-owned field.
 *
 * @param {object} config  Parsed target-owned agenticloop.json (mutated).
 * @param {string[]} hosts  Selected adapter hosts to reconcile.
 * @param {string[]} canonicalRoles  Current canonical role names.
 * @returns {{added: string[], preserved: string[]}}
 */
export function reconcileAdapterRoleSettings(config, hosts, canonicalRoles) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('agenticloop.json must contain a JSON object');
  }

  const added = [];
  const preserved = [];

  if (config.adapters === undefined) {
    config.adapters = {};
    added.push('adapters');
  } else if (
    typeof config.adapters !== 'object' ||
    config.adapters === null ||
    Array.isArray(config.adapters)
  ) {
    throw new Error('agenticloop.json: adapters must be an object');
  } else {
    preserved.push('adapters');
  }

  for (const host of hosts) {
    if (config.adapters[host] === undefined) {
      config.adapters[host] = {};
      added.push(`adapters.${host}`);
    } else if (typeof config.adapters[host] !== 'object' || config.adapters[host] === null || Array.isArray(config.adapters[host])) {
      throw new Error(`agenticloop.json: adapters.${host} must be an object`);
    } else {
      preserved.push(`adapters.${host}`);
    }

    if (config.adapters[host].roleSettings === undefined) {
      config.adapters[host].roleSettings = {};
      added.push(`adapters.${host}.roleSettings`);
    } else if (typeof config.adapters[host].roleSettings !== 'object' || config.adapters[host].roleSettings === null || Array.isArray(config.adapters[host].roleSettings)) {
      throw new Error(`agenticloop.json: adapters.${host}.roleSettings must be an object`);
    } else {
      preserved.push(`adapters.${host}.roleSettings`);
    }

    for (const role of canonicalRoles) {
      const path = `adapters.${host}.roleSettings.${role}`;
      if (config.adapters[host].roleSettings[role] === undefined) {
        config.adapters[host].roleSettings[role] = {};
        added.push(path);
      } else if (typeof config.adapters[host].roleSettings[role] !== 'object' || config.adapters[host].roleSettings[role] === null || Array.isArray(config.adapters[host].roleSettings[role])) {
        throw new Error(`agenticloop.json: ${path} must be an object`);
      } else {
        preserved.push(path);
      }
    }
  }

  return { added, preserved };
}
