/**
 * Non-serialized provenance for presentation routing.
 *
 * Routing fields are derived from the selected target's role capabilities.
 * Keeping that capability object beside a presented diagnostic lets the
 * canonical envelope validate the derivation without falling back to a
 * different target. Consumers validating parsed JSON must supply the matching
 * capabilities explicitly.
 */

const ROUTING_CAPABILITIES = Symbol('agenticloop.diagnostic-routing-capabilities');

export function bindDiagnosticRoutingCapabilities(diagnostic, capabilities) {
  if (!diagnostic || typeof diagnostic !== 'object' || !capabilities) return diagnostic;
  Object.defineProperty(diagnostic, ROUTING_CAPABILITIES, {
    configurable: false,
    enumerable: false,
    value: capabilities,
    writable: false,
  });
  return diagnostic;
}

export function diagnosticRoutingCapabilities(diagnostic, explicitCapabilities = null) {
  return explicitCapabilities ?? diagnostic?.[ROUTING_CAPABILITIES] ?? null;
}
