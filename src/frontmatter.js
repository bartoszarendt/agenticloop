// @ts-check

/**
 * Minimal YAML-ish frontmatter parser for Markdown files.
 * Parses indentation-based nested mappings, scalar sequences, inline arrays,
 * quoted values, and YAML literal/folded block scalars.
 * Returns [frontmatterDict | null, bodyString]. `parseFrontmatter` is retained
 * for compatibility; contract-sensitive callers use `parseFrontmatterStrict`.
 */

/**
 * @param {string} raw
 * @returns {{ indent: number, key: string, rawValue: string } | null}
 */
function parseKeyValueLine(raw) {
  const match = raw.match(/^(\s*)(?:"([^"]+)"|'([^']+)'|([^:#][^:]*?)):\s*(.*)$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    key: (match[2] ?? match[3] ?? match[4] ?? '').trim(),
    rawValue: match[5] ?? '',
  };
}

/**
 * @param {string} rawValue
 * @returns {{ value: string | unknown[] | Record<string, unknown>, isObject: boolean }}
 */
function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (value === '') {
    return { value: {}, isObject: true };
  }

  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted) {
    return { value: value.slice(1, -1), isObject: false };
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return { value: [], isObject: false };
    const values = [];
    let current = '';
    let quote = '';
    for (const char of inner) {
      if ((char === '"' || char === "'") && (!quote || quote === char)) {
        quote = quote ? '' : char;
        current += char;
      } else if (char === ',' && !quote) {
        values.push(parseScalar(current).value);
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) values.push(parseScalar(current).value);
    return { value: values, isObject: false };
  }

  return { value, isObject: false };
}

/** @param {string} raw */
function indentation(raw) {
  return raw.match(/^\s*/)?.[0].length ?? 0;
}

/** @param {string[]} lines @param {number} index @param {number} parentIndent */
function nestedContainer(lines, index, parentIndent) {
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const raw = lines[cursor];
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (indentation(raw) <= parentIndent) return {};
    return /^\s*-\s+/.test(raw) ? [] : {};
  }
  return {};
}

/** @param {string[]} lines @param {number} index @param {number} parentIndent @param {string} style */
function blockScalar(lines, index, parentIndent, style) {
  const collected = [];
  let cursor = index + 1;
  for (; cursor < lines.length; cursor++) {
    const raw = lines[cursor];
    if (raw.trim() && indentation(raw) <= parentIndent) break;
    collected.push(raw);
  }
  const nonEmptyIndents = collected.filter(line => line.trim()).map(indentation);
  const contentIndent = nonEmptyIndents.length ? Math.min(...nonEmptyIndents) : parentIndent + 1;
  const values = collected.map(line => line.trim() ? line.slice(contentIndent) : '');
  let value;
  if (style.startsWith('>')) {
    value = values.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/\n{3,}/g, '\n\n');
  } else {
    value = values.join('\n');
  }
  if (style.endsWith('-')) value = value.replace(/\n+$/, '');
  else if (!style.endsWith('+') && value) value = value.replace(/\n*$/, '\n');
  return { value, nextIndex: cursor - 1 };
}

/**
 * @typedef {{ data: Record<string, unknown> | null, reason: string | null }} StrictFrontmatterData
 */

/**
 * Parse a frontmatter payload strictly. Unlike the legacy parser this rejects
 * malformed lines instead of silently ignoring them.
 *
 * @param {string} fmText
 * @returns {StrictFrontmatterData}
 */
function parseFrontmatterData(fmText) {

  /** @type {Record<string, unknown>} */
  const data = {};
  /** @type {{ indent: number, value: Record<string, unknown> | unknown[] }[]} */
  const stack = [{ indent: -1, value: data }];

  const lines = fmText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentation(raw);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (Array.isArray(parent)) {
      const item = raw.match(/^\s*-\s+(.+?)\s*$/);
      if (!item) return { data: null, reason: `invalid_yaml_line:${index + 1}` };
      parent.push(parseScalar(item[1]).value);
      continue;
    }
    if (!parent || typeof parent !== 'object') return { data: null, reason: `invalid_yaml_line:${index + 1}` };

    const parsedLine = parseKeyValueLine(raw);
    if (!parsedLine) return { data: null, reason: `invalid_yaml_line:${index + 1}` };

    const { key, rawValue } = parsedLine;
    const scalarStyle = rawValue.trim();
    if (/^[>|][+-]?$/.test(scalarStyle)) {
      const parsedBlock = blockScalar(lines, index, indent, scalarStyle);
      parent[key] = parsedBlock.value;
      index = parsedBlock.nextIndex;
      continue;
    }

    if (rawValue.trim() === '') {
      const container = nestedContainer(lines, index, indent);
      parent[key] = container;
      stack.push({ indent, value: container });
      continue;
    }

    const value = rawValue.trim();
    if ((value.startsWith('"') && !value.endsWith('"')) ||
        (value.startsWith("'") && !value.endsWith("'")) ||
        (value.startsWith('[') && !value.endsWith(']'))) {
      return { data: null, reason: `invalid_yaml_value:${index + 1}` };
    }
    const parsedValue = parseScalar(rawValue);
    parent[key] = parsedValue.value;
    if (parsedValue.isObject) {
      stack.push({ indent, value: /** @type {Record<string, unknown>} */ (parent[key]) });
    }
  }

  return { data, reason: null };
}

/**
 * Parse leading Markdown frontmatter without converting malformed structure
 * into an absent block. Exactly one leading BOM is normalized; leading
 * whitespace is not, because it changes the document shape.
 *
 * @param {string} content
 * @returns {{ state: 'absent', data: null, body: string, reason: null }|{ state: 'valid', data: Record<string, unknown>, body: string, reason: null }|{ state: 'malformed', data: null, body: string, reason: string }}
 */
export function parseFrontmatterStrict(content) {
  const original = String(content ?? '');
  const normalized = original.startsWith('\uFEFF') ? original.slice(1) : original;
  if (!normalized.startsWith('---')) {
    return { state: 'absent', data: null, body: original, reason: null };
  }

  const opening = normalized.match(/^---[ \t]*\r?\n/);
  if (!opening) {
    return {
      state: 'malformed',
      data: null,
      body: normalized,
      reason: 'invalid_opening_delimiter',
    };
  }

  const afterOpening = normalized.slice(opening[0].length);
  const immediateClosing = afterOpening.match(/^---[ \t]*(?=\r?\n|$)/);
  const closing = /\r?\n---[ \t]*(?=\r?\n|$)/g;
  closing.lastIndex = opening[0].length;
  const closingMatch = immediateClosing ? null : closing.exec(normalized);
  if (!immediateClosing && !closingMatch) {
    return {
      state: 'malformed',
      data: null,
      body: normalized,
      reason: 'missing_closing_delimiter',
    };
  }

  const closingIndex = immediateClosing ? opening[0].length : /** @type {RegExpExecArray} */ (closingMatch).index;
  const closingLength = immediateClosing ? immediateClosing[0].length : /** @type {RegExpExecArray} */ (closingMatch)[0].length;
  const fmText = normalized.slice(opening[0].length, closingIndex);
  let bodyOffset = closingIndex + closingLength;
  if (normalized.startsWith('\r\n', bodyOffset)) bodyOffset += 2;
  else if (normalized.startsWith('\n', bodyOffset)) bodyOffset += 1;
  const parsed = parseFrontmatterData(fmText);
  if (!parsed.data) {
    return {
      state: 'malformed',
      data: null,
      body: normalized.slice(bodyOffset),
      reason: parsed.reason ?? 'invalid_frontmatter_shape',
    };
  }
  return { state: 'valid', data: parsed.data, body: normalized.slice(bodyOffset), reason: null };
}

/**
 * Compatibility parser for callers that historically accepted partial
 * YAML-ish content. Contract-sensitive callers must use
 * `parseFrontmatterStrict()` instead.
 *
 * @param {string} content
 * @returns {[Record<string, unknown> | null, string]}
 */
export function parseFrontmatter(content) {
  if (!content.startsWith('---')) return [null, content];

  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!match) return [null, content];

  const fmText = match[1];
  const body = match[2] ?? '';
  /** @type {Record<string, unknown>} */
  const data = {};
  /** @type {{ indent: number, value: Record<string, unknown> | unknown[] }[]} */
  const stack = [{ indent: -1, value: data }];

  const lines = fmText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentation(raw);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();

    const parent = stack[stack.length - 1].value;
    if (Array.isArray(parent)) {
      const item = raw.match(/^\s*-\s+(.+?)\s*$/);
      if (item) parent.push(parseScalar(item[1]).value);
      continue;
    }
    if (!parent || typeof parent !== 'object') continue;

    const parsedLine = parseKeyValueLine(raw);
    if (!parsedLine) continue;
    const { key, rawValue } = parsedLine;
    const scalarStyle = rawValue.trim();
    if (/^[>|][+-]?$/.test(scalarStyle)) {
      const parsedBlock = blockScalar(lines, index, indent, scalarStyle);
      parent[key] = parsedBlock.value;
      index = parsedBlock.nextIndex;
      continue;
    }
    if (rawValue.trim() === '') {
      const container = nestedContainer(lines, index, indent);
      parent[key] = container;
      stack.push({ indent, value: container });
      continue;
    }
    const parsedValue = parseScalar(rawValue);
    parent[key] = parsedValue.value;
    if (parsedValue.isObject) stack.push({ indent, value: /** @type {Record<string, unknown>} */ (parent[key]) });
  }

  return [data, body];
}
