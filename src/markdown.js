// @ts-check

/**
 * Small, dependency-free Markdown structure helpers for Agentic Loop's
 * mechanical contracts. These helpers intentionally cover only the structures
 * the toolkit needs, but they preserve Markdown's distinction between logical
 * blocks and physical source lines.
 */

/** @param {string} value */
function leadingIndentColumns(value) {
  let columns = 0;
  for (const char of value) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/**
 * Return source lines annotated with whether they are live Markdown rather
 * than fenced code, indented code, or a blockquote.
 *
 * @param {string} markdown
 * @returns {{ raw: string, line: number, live: boolean }[]}
 */
export function markdownLines(markdown) {
  const sourceLines = String(markdown ?? '').split(/\r?\n/);
  const result = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLength = 0;

  for (let index = 0; index < sourceLines.length; index++) {
    const raw = sourceLines[index];
    const leadingSpaces = raw.match(/^ */)?.[0].length ?? 0;
    const afterSpaces = raw.slice(leadingSpaces);
    const fence = afterSpaces.match(/^(`{3,}|~{3,})(.*)$/);

    if (fence && leadingSpaces <= 3) {
      const char = fence[1][0];
      const length = fence[1].length;
      const suffix = fence[2];
      if (!inFence && !(char === '`' && suffix.includes('`'))) {
        inFence = true;
        fenceChar = char;
        fenceLength = length;
        result.push({ raw, line: index + 1, live: false });
        continue;
      }
      if (inFence && char === fenceChar && length >= fenceLength && /^[ \t]*$/.test(suffix)) {
        inFence = false;
        fenceChar = '';
        fenceLength = 0;
        result.push({ raw, line: index + 1, live: false });
        continue;
      }
    }

    const trimmed = raw.trimStart();
    const live = !inFence && !trimmed.startsWith('>') &&
      !(leadingIndentColumns(raw) >= 4 && trimmed.length > 0);
    result.push({ raw, line: index + 1, live });
  }
  return result;
}

/**
 * Parse a live ATX heading. CommonMark permits zero to three leading spaces and
 * an optional closing sequence of hashes.
 *
 * @param {string} raw
 * @returns {{ level: number, text: string } | null}
 */
export function parseAtxHeading(raw) {
  const match = String(raw ?? '').match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/);
  if (!match) return null;
  const text = (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
  return { level: match[1].length, text };
}

/** @param {string} heading */
function requestedHeading(heading) {
  const parsed = parseAtxHeading(String(heading ?? '').trim());
  return parsed ?? { level: 2, text: String(heading ?? '').replace(/^#{1,6}\s*/, '').trim() };
}

/**
 * @param {string} markdown
 * @param {string} heading
 * @returns {{ headingLine: number, startLine: number, endLine: number, body: string } | null}
 */
export function markdownSection(markdown, heading) {
  const lines = markdownLines(markdown);
  const wanted = requestedHeading(heading);
  let headingIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].live) continue;
    const parsed = parseAtxHeading(lines[index].raw);
    if (parsed && parsed.level === wanted.level && parsed.text === wanted.text) {
      headingIndex = index;
      break;
    }
  }
  if (headingIndex === -1) return null;

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (!lines[index].live) continue;
    const parsed = parseAtxHeading(lines[index].raw);
    if (parsed && parsed.level <= wanted.level) {
      endIndex = index;
      break;
    }
  }
  return {
    headingLine: headingIndex,
    startLine: headingIndex + 1,
    endLine: endIndex,
    body: lines.slice(headingIndex + 1, endIndex).map(item => item.raw).join('\n').trim(),
  };
}

/** @param {string} markdown @param {string} heading */
export function hasMarkdownHeading(markdown, heading) {
  return markdownSection(markdown, heading) !== null;
}

/**
 * Parse top-level bullet items and join their indented continuation lines.
 * Nested bullets remain part of their parent item rather than becoming new
 * top-level records.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function topLevelListItems(markdown) {
  const items = [];
  let current = null;
  let listIndent = null;
  for (const item of markdownLines(markdown)) {
    if (!item.live) continue;
    const bullet = item.raw.match(/^( {0,3})[-+*][ \t]+(\S.*)$/);
    if (bullet && (listIndent === null || bullet[1].length === listIndent)) {
      if (listIndent === null) listIndent = bullet[1].length;
      if (current) items.push(current.join(' ').replace(/\s+/g, ' ').trim());
      current = [bullet[2].trim()];
      continue;
    }
    if (!current) continue;
    if (!item.raw.trim()) {
      items.push(current.join(' ').replace(/\s+/g, ' ').trim());
      current = null;
      continue;
    }
    if (/^[ \t]+\S/.test(item.raw)) {
      current.push(item.raw.trim());
      continue;
    }
    items.push(current.join(' ').replace(/\s+/g, ' ').trim());
    current = null;
  }
  if (current) items.push(current.join(' ').replace(/\s+/g, ' ').trim());
  return items.filter(Boolean);
}

/**
 * Join hard-wrapped live prose into logical blocks while retaining boundaries
 * at headings, blank lines, and new top-level list items.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function markdownProseBlocks(markdown) {
  /** @type {string[]} */
  const blocks = [];
  /** @type {string[]} */
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current.join(' ').replace(/\s+/g, ' ').trim());
    current = [];
  };
  for (const item of markdownLines(markdown)) {
    if (!item.live || !item.raw.trim() || parseAtxHeading(item.raw)) {
      flush();
      continue;
    }
    const bullet = item.raw.match(/^ {0,3}[-+*][ \t]+(.*)$/);
    if (bullet) {
      flush();
      current.push(bullet[1].trim());
      continue;
    }
    current.push(item.raw.trim());
  }
  flush();
  return blocks.filter(Boolean);
}

/** @param {string} value */
function stripCodeSpans(value) {
  return value.replace(/(`+)([\s\S]*?)\1/g, match => ' '.repeat(match.length));
}

/** @param {string} value */
function normalizeReferenceLabel(value) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Extract inline and full/collapsed reference-style Markdown links from live
 * Markdown. Link labels may span physical lines.
 *
 * @param {string} markdown
 * @returns {{ url: string, line: number }[]}
 */
export function markdownLinks(markdown) {
  const lines = markdownLines(markdown);
  const references = new Map();
  const definitionLines = new Set();
  for (const item of lines) {
    if (!item.live) continue;
    const match = item.raw.match(/^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))/);
    if (!match) continue;
    references.set(normalizeReferenceLabel(match[1]), match[2] ?? match[3]);
    definitionLines.add(item.line);
  }

  const visible = lines.map(item => item.live ? stripCodeSpans(item.raw) : '').join('\n');
  /** @param {number} index */
  const lineAt = index => visible.slice(0, index).split('\n').length;
  const found = [];

  for (let index = 0; index < visible.length; index++) {
    if (visible[index] !== '[' || visible[index - 1] === '\\') continue;
    const start = index;
    let close = index + 1;
    while (close < visible.length && (visible[close] !== ']' || visible[close - 1] === '\\')) close++;
    if (close >= visible.length) break;
    const label = visible.slice(index + 1, close);
    const line = lineAt(start);
    if (definitionLines.has(line)) {
      index = close;
      continue;
    }

    if (visible[close + 1] === '(') {
      let cursor = close + 2;
      while (/[ \t\n]/.test(visible[cursor] ?? '')) cursor++;
      let url = '';
      if (visible[cursor] === '<') {
        const end = visible.indexOf('>', cursor + 1);
        if (end !== -1) url = visible.slice(cursor + 1, end);
      } else {
        let depth = 0;
        for (; cursor < visible.length; cursor++) {
          const char = visible[cursor];
          if (char === '\\' && cursor + 1 < visible.length) {
            url += visible[cursor + 1];
            cursor++;
            continue;
          }
          if (char === '(') depth++;
          if (char === ')') {
            if (depth === 0) break;
            depth--;
          }
          if (depth === 0 && /[ \t\n]/.test(char)) break;
          url += char;
        }
      }
      if (url) found.push({ url, line });
      index = close;
      continue;
    }

    if (visible[close + 1] === '[') {
      const refClose = visible.indexOf(']', close + 2);
      if (refClose !== -1) {
        const reference = visible.slice(close + 2, refClose) || label;
        const url = references.get(normalizeReferenceLabel(reference));
        if (url) found.push({ url, line });
        index = refClose;
      }
    } else {
      const url = references.get(normalizeReferenceLabel(label));
      if (url) found.push({ url, line });
    }
  }
  return found;
}
