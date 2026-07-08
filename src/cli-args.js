/**
 * Shared CLI argument parsing helpers.
 *
 * Used by the top-level router (`cli.js`) and subcommand modules such as
 * `task-cli.js` so option parsing and unknown-option warnings stay consistent.
 */

const REPEATABLE_OPTIONS = new Set(['adapter', 'ref']);

export function toCamelCase(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function toKebabCase(s) {
  return s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

export function parseArgs(rawArgs) {
  const opts = {};
  const positional = [];
  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const key = toCamelCase(arg.slice(2));
      const next = rawArgs[i + 1];
      if (REPEATABLE_OPTIONS.has(key) && next !== undefined && !next.startsWith('--')) {
        if (!Array.isArray(opts[key])) opts[key] = [];
        opts[key].push(next);
        i += 2;
      } else if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i += 2;
      } else {
        opts[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { opts, positional };
}

export function warnUnknownOptions(opts, allowed, commandLabel) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(opts).filter(key => !allowedSet.has(key));
  if (unknown.length > 0) {
    console.warn(`  WARN: ${commandLabel} ignoring unknown option(s): ${unknown.map(key => `--${toKebabCase(key)}`).join(', ')}`);
  }
}
