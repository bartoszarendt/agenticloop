/**
 * Revision resolution matrix evaluator for Agentic Loop.
 *
 * Validates that every prior required finding from a needs_revision review
 * has exactly one disposition (resolved, disputed, or blocked) with current
 * evidence before re-review can proceed.
 *
 * Backend-neutral: used by GitHub preflight and files task validation.
 */

import { markdownLines, markdownSection, topLevelListItems } from './markdown.js';

export const VALID_DISPOSITIONS = new Set(['resolved', 'disputed', 'blocked']);
export const FINDING_ID_RE = /^F-[1-9]\d*$/;
export const RESOLUTION_ENTRY_SHAPE =
  '"- [F-1] resolved|disputed|blocked: <evidence> [ref: <reference>]"';

function resolutionShapeError() {
  return 'revision resolution entries must be live top-level bullet entries outside fenced code, blockquotes, and indented code; ' +
    `expected: ${RESOLUTION_ENTRY_SHAPE}`;
}

function emptyResolutionError() {
  return `revision resolution section is empty; expected: ${RESOLUTION_ENTRY_SHAPE}`;
}

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
 * @returns {{ status: 'absent'|'malformed'|'parsed', found: boolean, entries: Array, errors: string[] }}
 */
export function parseResolutionMatrix(text) {
  const raw = String(text ?? '');

  // Try to find the section
  const section = markdownSection(raw, '## Revision Resolution') ??
    markdownSection(raw, '## Resolution Matrix') ??
    markdownSection(raw, '## Finding Resolution');

  if (!section) {
    return { status: 'absent', found: false, entries: [], errors: [] };
  }

  const sectionLines = section.lines ?? markdownLines(section.body);
  const liveLines = sectionLines.filter(line => line.live && line.raw.trim());
  if (liveLines.length === 1 && /^none\.?$/i.test(liveLines[0].raw.trim())) {
    return { status: 'parsed', found: true, entries: [], errors: [] };
  }

  const entries = [];
  const errors = [];
  const entryRe = /^\[([^\]]+)\][ \t]+([A-Za-z_]+)[ \t]*:[ \t]*(.*?)\s*$/i;
  const malformed = [];
  const items = /** @type {{ text: string, lineNumbers: number[], marker: string }[]} */ (
    topLevelListItems('', { lines: sectionLines, includeMetadata: true })
  );
  const coveredLines = new Set(items.flatMap(item => item.lineNumbers));
  for (const item of items) {
    const match = item.text.match(entryRe);
    if (item.marker !== '-' || !match) {
      malformed.push({ text: item.text, disposition: null });
      continue;
    }

    const findingId = match[1].trim();
    const disposition = match[2].toLowerCase();
    const evidenceWithReference = match[3].trim();
    if (!VALID_DISPOSITIONS.has(disposition) || !evidenceWithReference) {
      malformed.push({ text: item.text, disposition });
      continue;
    }

    const refMatch = evidenceWithReference.match(/^(.*?)\s*\[ref:\s*(.+?)\s*\]\s*$/);
    const entry = {
      findingId,
      disposition,
      evidence: refMatch ? refMatch[1].trim() : evidenceWithReference,
      reference: refMatch ? refMatch[2].trim() : null,
    };
    if (!entry.evidence) {
      malformed.push({ text: item.text, disposition });
      continue;
    }
    entries.push(entry);
  }

  for (const line of liveLines) {
    if (!coveredLines.has(line.line)) {
      malformed.push({ text: line.raw.trim(), disposition: null });
    }
  }

  // When no live entry parses, one canonical repair route is more useful than
  // one downstream missing-finding error per required ID.
  if (entries.length === 0) {
    const hasNonblankContent = sectionLines.some(line => line.raw.trim());
    return {
      status: 'malformed',
      found: true,
      entries: [],
      errors: [hasNonblankContent ? resolutionShapeError() : emptyResolutionError()],
    };
  }

  for (const item of malformed) {
    if (item.disposition && !VALID_DISPOSITIONS.has(item.disposition)) {
      errors.push(`unknown disposition '${item.disposition}' in resolution bullet entry; expected one of: ${[...VALID_DISPOSITIONS].join(', ')}; expected: ${RESOLUTION_ENTRY_SHAPE}`);
    } else {
      errors.push(`malformed resolution bullet entry '${item.text}'; expected: ${RESOLUTION_ENTRY_SHAPE}`);
    }
  }
  // Check for duplicate finding IDs
  const seenIds = new Set();
  for (const entry of entries) {
    if (!FINDING_ID_RE.test(entry.findingId)) {
      errors.push(`resolution finding identifier '${entry.findingId}' is not canonical (expected F-<positive integer>)`);
    }
    if (seenIds.has(entry.findingId)) {
      errors.push(`duplicate finding identifier '${entry.findingId}' in resolution matrix`);
    }
    seenIds.add(entry.findingId);
  }

  return { status: 'parsed', found: true, entries, errors };
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

  // Every prior finding must have exactly one bullet entry.
  const entryMap = new Map(entries.map(e => [e.findingId, e]));
  for (const id of requiredFindingIds) {
    const entry = entryMap.get(id);
    if (!entry) {
      errors.push(`prior finding '${id}' has no bullet entry in the resolution matrix; expected: ${RESOLUTION_ENTRY_SHAPE}`);
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
