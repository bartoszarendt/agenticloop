/**
 * Codex model and reasoning helpers shared by adapter generation,
 * validation, and generated-artifact preservation.
 */

export const CODEX_SUPPORTED_REASONING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const CODEX_SUPPORTED_REASONING_EFFORTS_DISPLAY =
  'minimal, low, medium, high, xhigh';

export function normalizeCodexReasoningEffort(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'auto') return '';
  return CODEX_SUPPORTED_REASONING_EFFORTS.has(trimmed) ? trimmed : '';
}

export function isLegacyCodexCliModel(value) {
  return typeof value === 'string' && value.trim().startsWith('codex-cli/');
}

export function normalizeCodexModel(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return isLegacyCodexCliModel(trimmed)
    ? trimmed.slice('codex-cli/'.length)
    : trimmed;
}
