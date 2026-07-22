/**
 * Credential-safe serialization for attached supervision.
 *
 * Host-derived strings (OpenCode permission commands, error text, paths) may
 * contain credentials. The mechanical risk classifier needs the exact original
 * text, but nothing else does: public status, the supervisor model payload,
 * notifications, diagnostics, durable run state, and JSONL events must never
 * carry it. This module is the single place that decides what a secret looks
 * like and how it is withheld.
 */

const SECRET_PATTERNS = [
  // Explicit bearer / basic credentials. Matched first so a later, narrower
  // header rule cannot strip the scheme word and strand the token.
  /\b(?:bearer|basic)[\s_:=-]+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Authorization headers in any common shell/header spelling. The value part
  // absorbs an optional scheme word plus the token that follows it.
  /(?:^|[\s"'`([{,;&|])(?:-H\s*['"]?\s*)?(?:proxy-)?authorization\s*[:=]\s*['"]?(?:(?:bearer|basic|token)[\s_-]+)?[^\s'"`)\]},;&|]+/gi,
  // Cookies and custom authentication headers are credentials even when they
  // do not use the standard Authorization header name.
  /(?:^|[\s"'`([{,;&|])(?:-H\s*['"]?\s*)?(?:set-)?cookie\s*[:=]\s*['"]?[^\s'"`)\]},;&|]+/gi,
  /(?:^|[\s"'`([{,;&|])(?:-H\s*['"]?\s*)?(?:x[-_])?(?:auth|authentication|api[-_]?key|access[-_]?token|session[-_]?token)\s*[:=]\s*['"]?[^\s'"`)\]},;&|]+/gi,
  // key=value / key: value for credential-like names.
  /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd|passphrase|credential|token|secret)\b\s*[:=]\s*['"]?[^\s'"`)\]},;&|]+/gi,
  // Credential-shaped environment assignments (FOO_TOKEN=..., MY_API_KEY=...).
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PASSPHRASE)[A-Z0-9_]*\s*=\s*['"]?[^\s'"`)\]},;&|]+/g,
  // CLI credential flags.
  /--?(?:token|password|passwd|api-?key|secret|auth|credential|bearer)(?:[=\s]+)['"]?[^\s'"`)\]},;&|-][^\s'"`)\]},;&|]*/gi,
  // URLs carrying userinfo.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s'"`)\]},;&|]*/gi,
  // URLs carrying a secret query parameter.
  /[?&](?:token|access_token|refresh_token|id_token|api_key|apikey|key|secret|password|sig|signature|auth|code)=[^&\s'"`)\]},;&|]+/gi,
  // Package-manager and registry credential spellings such as npm's
  // `//registry/:_authToken VALUE` form.
  /(?:^|[\s/:.])_?auth(?:entication)?token\b\s*(?::|=|\s)\s*['"]?[^\s'"`)\]},;&|]+/gi,
  // Well-known provider token shapes.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

export const REDACTION_MARKER = '[redacted]';

/**
 * True when the value contains material that looks like a credential. Used to
 * decide whether a permission scope can still be trusted after redaction.
 */
export function containsSensitiveMaterial(value) {
  if (typeof value !== 'string' || !value) return false;
  return SECRET_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

/**
 * Replace every detected credential with a non-secret marker. The result is
 * deterministic so an identical input always produces an identical output.
 */
export function redactSecrets(value) {
  if (typeof value !== 'string' || !value) return typeof value === 'string' ? value : '';
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, match => {
      const leading = /^[\s"'`([{,;&|]/.test(match) ? match[0] : '';
      return `${leading}${REDACTION_MARKER}`;
    });
  }
  return result;
}

/**
 * Redact and bound one host-derived string for any public, model-bound, or
 * durable surface.
 */
export function safeText(value, limit = 300) {
  return redactSecrets(String(value ?? '')).slice(0, limit);
}

/**
 * Recursively redact a structured payload. Values are bounded and secret-named
 * keys are dropped entirely rather than redacted in place.
 */
export function safeStructure(value, { depth = 0, maxDepth = 4, stringLimit = 500, keyFilter = () => false } = {}) {
  if (depth > maxDepth) return '[truncated]';
  if (typeof value === 'string') return safeText(value, stringLimit);
  if (Array.isArray(value)) return value.slice(0, 20).map(entry => safeStructure(entry, { depth: depth + 1, maxDepth, stringLimit, keyFilter }));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !keyFilter(key))
      .slice(0, 30)
      .map(([key, entry]) => [key, safeStructure(entry, { depth: depth + 1, maxDepth, stringLimit, keyFilter })])
  );
}
