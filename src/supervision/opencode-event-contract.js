/**
 * Single source of truth for the two host-fact decisions the generated OpenCode
 * bridge makes: what counts as a genuinely unique event identity, and how a
 * host result maps to a host-neutral invocation outcome.
 *
 * Both functions are deliberately self-contained (no imports, no module-scope
 * references) so `renderOpencodeEventContract()` can serialize them verbatim
 * into the generated plugin. Tests import the same functions, so there is no
 * test-only duplicate that can drift from the shipped bridge.
 */

/**
 * Extract a documented, genuinely per-event OpenCode identity.
 *
 * OpenCode 1.18.4 does not publish a per-delivery event identifier on its event
 * bus. `properties.id` is a *domain* identity -- the permission id on
 * `permission.updated`, the session id on session events -- and it is reused
 * across every later update of the same object. Substituting it (or the event
 * type, or the session id) as an event identity silently suppresses every later
 * event of that kind, so this helper returns `null` unless the pinned schema
 * proves the field is unique for that single event. A null identity is correct:
 * the kernel treats a falsy event id as non-deduplicable and processes the event.
 *
 * @param {{ type?: string, properties?: Record<string, any> }} event
 * @returns {string|null}
 */
export function extractOpencodeEventId(event) {
  const properties = (event && event.properties) || {};
  const type = String((event && event.type) || "");
  if (!type) return null;
  if (type === "tool.execute.after" || type === "tool.execute.before") {
    // `callID` identifies one tool invocation; the after-event fires once for it.
    const callID = properties.callID || (properties.tool && properties.tool.callID);
    return callID ? type + ":" + String(callID) : null;
  }
  if (type === "message.part.updated") {
    // A part is uniquely addressed by message + part id within a session.
    const part = properties.part || {};
    if (part.id && part.messageID) return type + ":" + String(part.messageID) + ":" + String(part.id);
    return null;
  }
  // session.idle, session.error, session.updated, session.busy and
  // message.updated carry no per-event identity in the pinned schema.
  return null;
}

/**
 * Map an OpenCode error/result payload to a host-neutral invocation outcome.
 *
 * Precedence is deterministic and documented:
 *   1. Structured codes/status take priority over prose. A structured signal
 *      always wins over contradicting free text.
 *   2. Within textual evidence, the fixed order is:
 *      cancellation -> permission rejection -> permission wait -> context
 *      exhaustion -> rate limit -> quota/capacity -> auth/configuration/model
 *      -> transport/network/server -> unknown.
 *
 * @param {Record<string, any>} properties
 * @returns {{ outcome: string, classification_source: string, retry_after_ms?: number }}
 */
export function classifyOpencodeOutcome(properties) {
  const value = properties && typeof properties === "object" ? properties : {};
  const error = value.error && typeof value.error === "object" ? value.error : {};
  const boundedRetryAfter = () => {
    const candidates = [
      value.retry_after_ms, value.retryAfterMs, error.retry_after_ms, error.retryAfterMs,
      value.retry_after, value.retryAfter, error.retry_after, error.retryAfter,
    ];
    for (const candidate of candidates) {
      const parsed = Number(candidate);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      // Values under 1000 are conventionally seconds in HTTP Retry-After.
      const milliseconds = parsed < 1000 ? parsed * 1000 : parsed;
      return Math.max(0, Math.min(900000, Math.round(milliseconds)));
    }
    return 0;
  };

  const codes = [value.code, value.errorCode, value.name, error.code, error.name, error.type]
    .filter(entry => typeof entry === "string" && entry.trim())
    .map(entry => entry.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const codeTable = [
    [/^(?:aborted|abort|cancell?ed|cancel|user_abort|interrupted)$/, "cancelled"],
    [/^(?:permission_rejected|permission_denied|permission_refused|tool_denied)$/, "permission_rejected"],
    [/^(?:permission_required|permission_pending|permission_wait|awaiting_permission)$/, "waiting_permission"],
    [/^(?:context_length_exceeded|context_overflow|context_limit|max_tokens_exceeded|token_limit_exceeded)$/, "failed_context"],
    [/^(?:rate_limit_exceeded|rate_limited|rate_limit|too_many_requests)$/, "failed_rate_limit"],
    [/^(?:insufficient_quota|quota_exceeded|capacity_exceeded|overloaded_error|overloaded|insufficient_credits|billing_error)$/, "failed_quota"],
    [/^(?:invalid_api_key|authentication_error|unauthenticated|unauthorized|forbidden|permission_error|model_not_found|invalid_model|invalid_request_error|configuration_error|provider_not_configured)$/, "failed_configuration"],
    [/^(?:network_error|timeout|timed_out|etimedout|econnreset|econnrefused|epipe|socket_hang_up|bad_gateway|service_unavailable|gateway_timeout|internal_server_error|api_connection_error)$/, "failed_transport"],
  ];
  for (const code of codes) {
    for (const entry of codeTable) {
      if (entry[0].test(code)) {
        const outcome = entry[1];
        if (outcome === "failed_rate_limit") return { outcome, classification_source: "structured_code", retry_after_ms: boundedRetryAfter() };
        return { outcome, classification_source: "structured_code" };
      }
    }
  }

  const statusCandidates = [value.status, value.statusCode, value.httpStatus, error.status, error.statusCode];
  for (const candidate of statusCandidates) {
    const status = Number(candidate);
    if (!Number.isInteger(status) || status < 400) continue;
    if (status === 429) return { outcome: "failed_rate_limit", classification_source: "structured_status", retry_after_ms: boundedRetryAfter() };
    if (status === 401 || status === 403 || status === 404 || status === 400) return { outcome: "failed_configuration", classification_source: "structured_status" };
    if (status === 402) return { outcome: "failed_quota", classification_source: "structured_status" };
    if (status === 408 || status >= 500) return { outcome: "failed_transport", classification_source: "structured_status" };
  }

  const text = [value.error, value.message, value.reason, value.detail, error.message, error.detail]
    .filter(entry => typeof entry === "string" && entry.trim())
    .join(" ")
    .toLowerCase();
  if (!text) return { outcome: "unknown", classification_source: "no_evidence" };
  const textTable = [
    [/(?:\bcancell?ed\b|\bcancel\b|\baborted\b|\babort\b|\binterrupted\b|user stopped)/, "cancelled"],
    [/(?:permission[^.]{0,40}(?:reject|den(?:y|ied)|refus)|(?:reject|den(?:y|ied)|refus)[^.]{0,40}permission)/, "permission_rejected"],
    [/(?:permission|approval)[^.]{0,40}(?:wait|pending|required|requested)/, "waiting_permission"],
    [/(?:context|token)[^.]{0,30}(?:exhaust|limit|overflow|too long|exceed)|session[^.]{0,20}(?:exhaust|overflow)/, "failed_context"],
    [/(?:rate.?limit|too many requests|\b429\b|retry.?after)/, "failed_rate_limit"],
    [/(?:quota|capacity|insufficient credits|insufficient funds|overloaded|provider unavailable|billing)/, "failed_quota"],
    [/(?:\bauth\w*|credential|api key|unauthorized|forbidden|configuration|model[^.]{0,20}(?:not found|unsupported|unavailable)|invalid model)/, "failed_configuration"],
    [/(?:timeout|timed out|network|transport|socket|connection|econn|etimedout|\b5\d\d\b|server error|bad gateway|service unavailable)/, "failed_transport"],
  ];
  for (const entry of textTable) {
    if (!entry[0].test(text)) continue;
    if (entry[1] === "failed_rate_limit") return { outcome: "failed_rate_limit", classification_source: "text", retry_after_ms: boundedRetryAfter() };
    return { outcome: entry[1], classification_source: "text" };
  }
  return { outcome: "unknown", classification_source: "unmatched_text" };
}

/**
 * Serialize both helpers into the generated plugin so the shipped bridge and
 * the deterministic tests execute the identical implementation.
 */
export function renderOpencodeEventContract() {
  return [
    '// Serialized verbatim from src/supervision/opencode-event-contract.js.',
    '// Tests exercise the same implementation; do not fork this logic.',
    extractOpencodeEventId.toString(),
    classifyOpencodeOutcome.toString(),
  ].join('\n');
}
