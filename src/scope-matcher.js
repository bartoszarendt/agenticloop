/**
 * Shared canonical scope matcher for Agentic Loop.
 *
 * Owns:
 * - field precedence: allowed_paths, then compatibility alias expected_files
 * - YAML-list validation
 * - safe repo-relative pattern validation
 * - forward-slash normalization
 * - exact-file, directory-ending-/, *, **, and ? semantics
 * - matching a path against the pattern collection
 * - explicit structured errors for malformed or unsafe entries
 */

import { markdownSection } from './markdown.js';
import { parseFrontmatter } from './frontmatter.js';

const SCOPE_MAP_FIELD_NAMES = ['allowed_paths', 'expected_files'];

export function isSafeScopePattern(pattern) {
  if (typeof pattern !== 'string') return false;
  const normalized = pattern.replace(/\\/g, '/');
  if (!normalized) return false;
  if (normalized.startsWith('/')) return false;
  if (normalized.includes('..')) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  return true;
}

export function globPatternToRegExp(pattern) {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const next = pattern[i + 1];
    if (c === '*' && next === '*') {
      regex += '.*';
      i++;
    } else if (c === '*') {
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  return new RegExp(`^${regex}$`);
}

export function fileMatchesScopePattern(file, pattern) {
  const normalizedFile = file.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  if (normalizedPattern.endsWith('/')) {
    return normalizedFile.startsWith(normalizedPattern) || normalizedFile === normalizedPattern.slice(0, -1);
  }
  return globPatternToRegExp(normalizedPattern).test(normalizedFile);
}

export function isFileInScope(file, patterns) {
  return patterns.some(pattern => fileMatchesScopePattern(file, pattern));
}

export function parseScopePatterns(issueBody) {
  const [frontmatter] = parseFrontmatter(String(issueBody ?? ''));
  if (!frontmatter) return null;

  for (const fieldName of SCOPE_MAP_FIELD_NAMES) {
    const value = frontmatter[fieldName];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      return { fieldName, patterns: null, error: `'${fieldName}' must be a YAML list` };
    }
    const patterns = [];
    for (const raw of value) {
      if (!isSafeScopePattern(raw)) {
        return { fieldName, patterns: null, error: `unsafe or malformed pattern in '${fieldName}': ${JSON.stringify(raw)}` };
      }
      patterns.push(raw.replace(/\\/g, '/'));
    }
    return { fieldName, patterns, error: null };
  }
  return null;
}

export function parseDeviations(prBody) {
  const sectionObj = markdownSection(String(prBody ?? ''), '## Deviations');
  const section = sectionObj?.body ?? null;
  if (section === null) return { section: null, entries: [], errors: [] };

  const trimmed = section.trim();
  if (!trimmed || /^none\.?$/i.test(trimmed)) {
    return { section, entries: [], errors: [] };
  }

  const entries = [];
  const errors = [];
  const pathRe = /^[-*]\s*`([^`]+)`\s*[:–—-]\s*(.*?)\s*$/i;
  let current = null;

  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    const pathMatch = line.match(pathRe);
    if (pathMatch) {
      if (current) entries.push(current);
      const devPath = pathMatch[1].trim();
      const reason = pathMatch[2].trim();
      if (!devPath) {
        errors.push('deviation entry has an empty path');
      } else if (!reason) {
        errors.push(`deviation entry for '${devPath}' has an empty reason`);
      } else {
        current = { path: devPath, reason };
      }
      continue;
    }
    if (current && /^\s+/.test(rawLine)) {
      current.reason += ` ${line}`;
    }
  }
  if (current) entries.push(current);

  const seenPaths = new Set();
  for (const entry of entries) {
    if (seenPaths.has(entry.path)) {
      errors.push(`duplicate deviation path: ${entry.path}`);
    }
    seenPaths.add(entry.path);
  }

  return { section, entries, errors };
}

export function validatePathsAgainstDeviations(prFiles, allowedPatterns, deviationEntries) {
  const unmatched = [];
  for (const file of prFiles) {
    if (!isFileInScope(file, allowedPatterns)) {
      unmatched.push(file);
    }
  }

  const missingDeviations = [];
  const declaredPaths = new Set(deviationEntries.map(e => e.path));
  const inScopeDeviations = [];
  for (const file of unmatched) {
    if (!declaredPaths.has(file)) {
      missingDeviations.push(file);
    }
  }
  
  // Check for deviations that are unnecessary (file is already in allowed paths)
  for (const entry of deviationEntries) {
    if (isFileInScope(entry.path, allowedPatterns)) {
      inScopeDeviations.push(entry.path);
    }
  }

  const prFileSet = new Set(prFiles);
  const staleDeviations = [];
  for (const entry of deviationEntries) {
    if (!prFileSet.has(entry.path) && !isFileInScope(entry.path, allowedPatterns)) {
      staleDeviations.push(entry.path);
    }
  }

  const errors = [];
  for (const file of missingDeviations) {
    errors.push(`unexpected file '${file}' has no declaration in ## Deviations`);
  }
  for (const file of staleDeviations) {
    errors.push(`deviation declared for '${file}' but the file is not in the current PR`);
  }
  for (const file of inScopeDeviations) {
    errors.push(`deviation declared for '${file}' but the file is already covered by allowed_paths`);
  }

  return { unmatched, missingDeviations, staleDeviations, inScopeDeviations, errors };
}