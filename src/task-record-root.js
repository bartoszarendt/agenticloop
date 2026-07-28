/** Canonical task-record root diagnostics shared by every task-body consumer. */

import { createDiagnostic } from './repair-policy.js';

export const CANONICAL_TASK_RECORD_PREREQUISITE = 'canonical_task_record';

/**
 * Evaluate root record integrity before dependent task parsers run. GitHub gives
 * us Unicode strings, not original bytes, so it cannot prove UTF-8 corruption.
 * Callers with raw bytes may pass them for fatal decoding evidence.
 */
export function evaluateTaskRecordRoot(body, { bytes = null } = {}) {
  const text = typeof body === 'string' ? body : String(body ?? '');
  if (bytes instanceof Uint8Array) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return root('task.body.utf8');
    }
  }
  if (text.startsWith('\uFEFF')) return root('task.body.bom');
  if (!/[\r\n]/.test(text) && /(?:---|##|task_id:)/.test(text)) {
    return root('task.body.collapsed_newlines');
  }
  return { ok: true, diagnostics: [], firstSafeRepair: null, utf8Integrity: bytes instanceof Uint8Array ? 'verified' : 'unavailable' };
}

function root(code) {
  const diagnostic = createDiagnostic({
    code,
    repairHint: 'Preserve the original task record, repair its canonical structure, then rerun the evaluation.',
    evidence: {
      state: 'malformed',
      prerequisite: CANONICAL_TASK_RECORD_PREREQUISITE,
      supplied: true,
    },
  });
  return {
    ok: false,
    diagnostics: [diagnostic],
    firstSafeRepair: 'Preserve the original task record, repair its canonical structure, then rerun the evaluation.',
    utf8Integrity: code === 'task.body.utf8' ? 'invalid' : 'unavailable',
  };
}
