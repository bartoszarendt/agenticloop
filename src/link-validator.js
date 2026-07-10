/**
 * Markdown link validator.
 *
 * Validates local file links in Markdown files against the filesystem.
 * Ignores HTTP/HTTPS, mailto, and anchor-only links. Understands the
 * mapping between package source layout and installed target layout.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import {
  TOOLKIT_SOURCE_RELATIVE_PATHS,
  toPackageSourcePath,
} from './layout.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/g;
const HTTP_LINK = /^https?:\/\//i;
const MAILTO_LINK = /^mailto:/i;
const ANCHOR_ONLY = /^#/;

// Maps installed paths back to package source paths.
// e.g. "agenticloop/AGENTIC_LOOP.md" -> "AGENTIC_LOOP.md"
function buildInstalledToSourceMap() {
  const map = new Map();
  for (const installed of TOOLKIT_SOURCE_RELATIVE_PATHS) {
    const source = toPackageSourcePath(installed);
    map.set(installed, source);
    map.set('/' + installed, source);
  }
  return map;
}

const installedToSource = buildInstalledToSourceMap();

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

/**
 * Extract Markdown links from content, skipping fenced code blocks.
 * @param {string} content
 * @returns {{text: string, url: string, line: number}[]}
 */
function extractLinks(content) {
  const links = [];
  let inFence = false;
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track fenced code blocks (``` or ~~~)
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const matches = line.matchAll(LINK_PATTERN);
    for (const match of matches) {
      links.push({
        text: match[1],
        url: match[2],
        line: i + 1,
      });
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

/**
 * Check whether a link URL should be validated.
 * Returns null for URLs we intentionally skip.
 * @param {string} url
 * @returns {boolean} true if the link should be validated as a local file reference
 */
function isLocalFileLink(url) {
  if (!url) return false;
  if (HTTP_LINK.test(url)) return false;
  if (MAILTO_LINK.test(url)) return false;
  if (ANCHOR_ONLY.test(url)) return false;
  return true;
}

/**
 * Resolve a Markdown link relative to the file that contains it.
 * @param {string} linkUrl  The URL from the Markdown link
 * @param {string} sourceFile  Absolute path of the Markdown file
 * @returns {string} Resolved absolute path
 */
function resolveLinkTarget(linkUrl, sourceFile) {
  // Handle anchor-only internal links (e.g. "#section")
  if (linkUrl.startsWith('#')) return null;

  const sourceDir = dirname(sourceFile);
  // Strip anchor from the URL if present
  const hashIdx = linkUrl.indexOf('#');
  const filePart = hashIdx >= 0 ? linkUrl.slice(0, hashIdx) : linkUrl;

  return resolve(sourceDir, filePart);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} LinkError
 * @property {string} file  Relative path of the file containing the broken link
 * @property {number} line  Line number
 * @property {string} url   The link URL
 * @property {string} target  The resolved path (or attempted path)
 * @property {string} message  Description of the problem
 */

/**
 * Validate links in a single Markdown file.
 * @param {string} filePath   Absolute path to the Markdown file
 * @param {string} rootDir    Absolute repo root (for relative paths in output)
 * @returns {LinkError[]}
 */
function validateFileLinks(filePath, rootDir) {
  const content = readFileSync(filePath, 'utf-8');
  const links = extractLinks(content);
  const errors = [];
  const relFile = relative(rootDir, filePath).replace(/\\/g, '/');

  for (const link of links) {
    if (!isLocalFileLink(link.url)) continue;

    const target = resolveLinkTarget(link.url, filePath);
    if (target === null) continue;

    // Check if the file exists
    if (!existsSync(target)) {
      errors.push({
        file: relFile,
        line: link.line,
        url: link.url,
        target: relative(rootDir, target).replace(/\\/g, '/'),
        message: `File not found: ${link.url}`,
      });
    }
  }

  return errors;
}

/**
 * Recursively find all Markdown files in a directory.
 * @param {string} dir
 * @param {Set<string>} excludeDirs  Directory names to exclude
 * @returns {string[]}
 */
function findMarkdownFiles(dir, excludeDirs = new Set(['node_modules', '.codegraph', '.git', 'tmp'])) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (excludeDirs.has(entry)) continue;
    if (entry.startsWith('.')) continue;

    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Check if directory should be excluded
      results.push(...findMarkdownFiles(full, excludeDirs));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Package-to-installed path validation
// ---------------------------------------------------------------------------

/**
 * Simulate the installed target layout and validate links from that perspective.
 * In the installed layout, files under `agenticloop/` in the target repo
 * correspond to files at the repository root in the package source.
 *
 * @param {string} repoRoot  Absolute path to the package repository root
 * @returns {LinkError[]}
 */
function validateInstalledLayoutLinks(repoRoot) {
  const errors = [];

  // Build a set of installed paths that exist
  const installedPaths = new Set(TOOLKIT_SOURCE_RELATIVE_PATHS);

  // For each Markdown file in the repo, check if it's one that gets
  // installed, then validate its links against both source and installed paths.
  const mdFiles = findMarkdownFiles(repoRoot);

  for (const filePath of mdFiles) {
    const content = readFileSync(filePath, 'utf-8');
    const links = extractLinks(content);
    const sourceRelPath = relative(repoRoot, filePath).replace(/\\/g, '/');

    // Determine the installed path equivalent
    const installedPath = installedToSource.get(sourceRelPath)
      ? sourceRelPath
      : installedToSource.get('/' + sourceRelPath)
        ? sourceRelPath
        : null;

    for (const link of links) {
      if (!isLocalFileLink(link.url)) continue;

      const target = resolveLinkTarget(link.url, filePath);
      if (target === null) continue;

      const relTarget = relative(repoRoot, target).replace(/\\/g, '/');

      // Check if the target exists in the package source
      if (!existsSync(target)) {
        // Try mapping to installed layout equivalent
        const installedEq = installedToSource.get(relTarget) ||
          installedToSource.get('/' + relTarget);

        if (installedEq && existsSync(join(repoRoot, installedEq))) {
          // Link maps to a valid installed-equivalent path — OK
          continue;
        }

        errors.push({
          file: sourceRelPath,
          line: link.line,
          url: link.url,
          target: relTarget,
          message: `File not found in package source (link: ${link.url})`,
        });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate all Markdown files in a directory.
 *
 * @param {string} rootDir  Absolute repo root
 * @param {object} [options]
 * @param {boolean} [options.skipInstalledLayout]  Skip installed-layout validation
 * @returns {{ errors: LinkError[], packageErrors: LinkError[], installedErrors: LinkError[] }}
 */
export function validateLinks(rootDir, options = {}) {
  const mdFiles = findMarkdownFiles(rootDir);
  const packageErrors = [];
  for (const filePath of mdFiles) {
    packageErrors.push(...validateFileLinks(filePath, rootDir));
  }

  let installedErrors = [];
  if (!options.skipInstalledLayout) {
    installedErrors = validateInstalledLayoutLinks(rootDir);
  }

  return {
    errors: packageErrors,
    packageErrors,
    installedErrors,
  };
}

/**
 * Format link validation results for display.
 *
 * @param {{ errors: LinkError[], packageErrors: LinkError[], installedErrors: LinkError[] }} result
 * @returns {string[]}
 */
export function formatLinkErrors(result) {
  const lines = [];
  const allErrors = [...result.packageErrors, ...result.installedErrors];

  if (allErrors.length === 0) {
    lines.push('All Markdown links validate.');
    return lines;
  }

  lines.push(`Found ${allErrors.length} broken link(s):`);
  for (const err of allErrors) {
    lines.push(`  ${err.file}:${err.line} — ${err.message}`);
  }

  return lines;
}
