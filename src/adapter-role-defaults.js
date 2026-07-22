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
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    }),
    engineer: Object.freeze({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
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
