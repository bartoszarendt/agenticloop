// @ts-check

/**
 * Minimal YAML-ish frontmatter parser for Markdown files.
 * Parses indentation-based nested mappings and quoted keys/values.
 * Returns [frontmatterDict | null, bodyString].
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
 * @returns {{ value: string | Record<string, unknown>, isObject: boolean }}
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

  return { value, isObject: false };
}

/**
 * @param {string} content
 * @returns {[Record<string, unknown> | null, string]}
 */
export function parseFrontmatter(content) {
  if (!content.startsWith('---')) {
    return [null, content];
  }

  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    return [null, content];
  }

  const fmText = match[1];
  const body = match[2] ?? '';

  /** @type {Record<string, unknown>} */
  const data = {};
  /** @type {{ indent: number, value: Record<string, unknown> }[]} */
  const stack = [{ indent: -1, value: data }];

  for (const raw of fmText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parsedLine = parseKeyValueLine(raw);
    if (!parsedLine) continue;

    const { indent, key, rawValue } = parsedLine;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) continue;

    const parsedValue = parseScalar(rawValue);
    parent[key] = parsedValue.value;
    if (parsedValue.isObject) {
      stack.push({ indent, value: /** @type {Record<string, unknown>} */ (parent[key]) });
    }
  }

  return [data, body];
}
