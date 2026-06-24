/**
 * Compatibility checks for optional host plugin distributions.
 */

export const SHARED_AGENTICLOOP_PLUGIN_CONFLICT_ERROR =
  'adapters.cursor.plugin.enabled cannot be combined with adapters.codex.plugin.enabled because both generated plugin modes use plugins/agenticloop/';

export function validateSharedAgenticLoopPluginCompatibility(alConfig) {
  if (
    alConfig.adapters?.cursor?.plugin?.enabled === true &&
    alConfig.adapters?.codex?.plugin?.enabled === true
  ) {
    return [SHARED_AGENTICLOOP_PLUGIN_CONFLICT_ERROR];
  }
  return [];
}

export function assertSharedAgenticLoopPluginCompatibility(alConfig) {
  const errors = validateSharedAgenticLoopPluginCompatibility(alConfig);
  if (errors.length > 0) {
    throw new Error(errors[0]);
  }
}
