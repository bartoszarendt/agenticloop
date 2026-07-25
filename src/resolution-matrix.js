/**
 * Revision resolution matrix evaluator for Agentic Loop.
 *
 * Validates that every prior required finding from a needs_revision review
 * has exactly one disposition (resolved, disputed, or blocked) with current
 * evidence before re-review can proceed.
 *
 * Backend-neutral: used by GitHub preflight and files task validation.
 */

import { markdownSection } from './markdown.js';

export const VALID_DISPOSITIONS = new Set(['resolved', 'disputed', 'blocked']);
export const FINDING_ID_RE = /^F-[1-9]\d*$/;

/**
 * Parse a resolution matrix from a Markdown section.
 * Expected shape:
 *
 * ## Revision Resolution
 * - [F-1] resolved: <evidence> [ref: <reference>]
 * - [F-2] disputed: <evidence>
 * - [F-3] blocked: <evidence> [ref: <reference>]
 *
 * @param {string} text Markdown text containing the matrix
 * @returns {{ found: boolean, entries: Array, errors: string[] }}
 */
export function parseResolutionMatrix(text) {
  const raw = String(text ?? '');

  // Try to find the section
  const section = markdownSection(raw, '## Revision Resolution') ??
    markdownSection(raw, '## Resolution Matrix') ??
    markdownSection(raw, '## Finding Resolution');

  if (!section) {
    return { found: false, entries: [], errors: [] };
  }

  const body = section.body;
  const trimmed = body.trim();
  if (!trimmed || /^none\.?$/i.test(trimmed)) {
    return { found: true, entries: [], errors: [] };
  }

  const entries = [];
  const errors = [];
  const entryRe = /^[-*]\s*\[([^\]]+)\]\s+(resolved|disputed|blocked)\s*:\s*(.+?)\s*$/gim;
  const lineEntryRe = /^[-*]\s*\[([^\]]+)\]\s+(resolved|disputed|blocked)\s*:\s*(.+?)\s*$/i;
  let match;

  while ((match = entryRe.exec(body)) !== null) {
    const findingId = match[1].trim();
    const disposition = match[2].trim().toLowerCase();
    const evidence = match[3].trim();

    // Check for optional ref
    const refMatch = evidence.match(/^(.*?)\s*\[ref:\s*(.+?)\s*\]\s*$/);
    const entry = {
      findingId,
      disposition,
      evidence: refMatch ? refMatch[1].trim() : evidence,
      reference: refMatch ? refMatch[2].trim() : null,
    };

    if (!entry.evidence) {
      errors.push(`resolution entry for '${findingId}' has empty evidence`);
    }
    if (!FINDING_ID_RE.test(findingId)) {
      errors.push(`resolution finding identifier '${findingId}' is not canonical (expected F-<positive integer>)`);
    }

    entries.push(entry);
  }

  // Check for malformed lines (lines that look like they should be entries but aren't)
  const lines = body.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('-') && !trimmedLine.startsWith('*')) continue;

    // Any bullet with a bracketed identifier is a claimed matrix row. Do not
    // silently ignore malformed rows because that can hide a duplicate or a
    // disposition outside the three-value protocol.
    if (/\[.+\]/.test(trimmedLine) && !lineEntryRe.test(trimmedLine)) {
      // Check for unknown disposition
      const dispMatch = trimmedLine.match(/\]\s+(\w+)\s*:/);
      if (dispMatch && !VALID_DISPOSITIONS.has(dispMatch[1].toLowerCase())) {
        errors.push(`unknown disposition '${dispMatch[1]}' in resolution entry`);
      } else {
        errors.push(`malformed resolution entry '${trimmedLine}'`);
      }
    }
  }
  // Check for duplicate finding IDs
  const seenIds = new Set();
  for (const entry of entries) {
    if (seenIds.has(entry.findingId)) {
      errors.push(`duplicate finding identifier '${entry.findingId}' in resolution matrix`);
    }
    seenIds.add(entry.findingId);
  }

  return { found: true, entries, errors };
}

/**
 * Validate a complete resolution matrix against prior required findings.
 *
 * @param {object} params
 * @param {Array<string>} params.requiredFindingIds Finding IDs from the prior
 *   needs_revision review (e.g., ['F-1', 'F-2', 'F-3']).
 * @param {Array<{ findingId: string, disposition: string, evidence: string }>} params.entries
 *   Parsed resolution matrix entries.
 * @param {string} [params.currentArtifact] Current implementation artifact for
 *   verifying resolved items cite current evidence.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateResolutionMatrix({
  requiredFindingIds = [],
  entries = [],
  currentArtifact = '',
} = {}) {
  const errors = [];
  const warnings = [];

  if (requiredFindingIds.length === 0) {
    // No prior findings: no matrix required
    if (entries.length > 0) {
      warnings.push('resolution matrix present but no prior findings exist');
    }
    return { valid: true, errors, warnings };
  }

  const requiredSet = new Set(requiredFindingIds);
  if (requiredSet.size !== requiredFindingIds.length) {
    errors.push('prior review contains duplicate finding identifiers');
  }
  const seenEntries = new Set();
  for (const entry of entries) {
    if (seenEntries.has(entry.findingId)) errors.push(`duplicate finding identifier '${entry.findingId}' in resolution matrix`);
    seenEntries.add(entry.findingId);
  }

  // Every prior finding must have exactly one row.
  const entryMap = new Map(entries.map(e => [e.findingId, e]));
  for (const id of requiredFindingIds) {
    const entry = entryMap.get(id);
    if (!entry) {
      errors.push(`prior finding '${id}' has no row in the resolution matrix`);
      continue;
    }

    // Validate disposition
    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      errors.push(`finding '${id}' has unknown disposition '${entry.disposition}'`);
    }

    // Validate evidence
    const evidence = String(entry.evidence ?? '').trim();
    if (!evidence) {
      errors.push(`finding '${id}' has empty evidence`);
    } else if (evidence.split(/\s+/).length < 3 || evidence.length < 12) {
      errors.push(`finding '${id}' evidence is not substantive`);
    }

    // resolved must cite current-artifact evidence
    if (entry.disposition === 'resolved' && currentArtifact) {
      const current = String(currentArtifact).toLowerCase();
      if (!evidence.toLowerCase().includes(current)) {
        errors.push(`finding '${id}' is marked resolved but does not cite current artifact '${currentArtifact}'`);
      }
    }

    // disputed must have a reference or route to maintainer
    if (entry.disposition === 'disputed' && !entry.reference) {
      errors.push(`finding '${id}' is disputed but has no durable maintainer reference`);
    }

    // blocked prevents review-ready status
    if (entry.disposition === 'blocked') {
      errors.push(`finding '${id}' is blocked; review cannot proceed until it is resolved or disputed`);
    }
  }

  // No extra entries (entries for findings not in the prior review)
  for (const entry of entries) {
    if (!requiredSet.has(entry.findingId)) {
      errors.push(`resolution entry '${entry.findingId}' does not match any prior finding`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Format a resolution matrix as a Markdown section.
 *
 * @param {Array<{ findingId: string, disposition: string, evidence: string, reference?: string }>} entries
 * @returns {string}
 */
export function formatResolutionMatrix(entries) {
  const lines = ['## Revision Resolution', ''];
  for (const entry of entries) {
    let line = `- [${entry.findingId}] ${entry.disposition}: ${entry.evidence}`;
    if (entry.reference) {
      line += ` [ref: ${entry.reference}]`;
    }
    lines.push(line);
  }
  lines.push('');
  return lines.join('\n');
}
