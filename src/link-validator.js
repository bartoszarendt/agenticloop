/** Validate Markdown links in package source and installed target layouts. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { INSTALLED_TOOLKIT_ROOT_DIRECTORY, isPackageSourceRepositoryRoot, toPackageSourcePath, TOOLKIT_SOURCE_RELATIVE_PATHS } from './layout.js';
import { markdownLinks } from './markdown.js';

const EXCLUDED = new Set(['node_modules', '.git', '.codegraph', 'tmp', '.agenticloop']);
const EXTERNAL = /^(https?:\/\/|mailto:|#)/i;

const TARGET_ROOT_FILES = new Set([
  'README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'agenticloop.json', 'package.json', 'package-lock.json',
  'opencode.jsonc', '.gitignore', '.gitattributes',
  'tsconfig.json', 'tsconfig.typecheck.json',
]);

function markdownFiles(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    if (EXCLUDED.has(name) || (name.startsWith('.') && name !== '.dev')) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) result.push(...markdownFiles(path));
    else if (name.endsWith('.md')) result.push(path);
  }
  return result;
}

function destination(raw) {
  const value = raw.trim();
  if (value.startsWith('<')) return value.slice(1, value.indexOf('>'));
  return value.match(/^([^\s]+)(?:\s+['"].*)?$/)?.[1] ?? value;
}

function links(content) {
  return markdownLinks(content).map(link => ({ ...link, url: destination(link.url) }));
}

function error(root, file, link, target, context) {
  return {
    file: relative(root, file).replaceAll('\\', '/'), line: link.line, url: link.url,
    target: target.replaceAll('\\', '/'), context,
    message: `${context} target not found: ${link.url} -> ${target.replaceAll('\\', '/')}`,
  };
}

function installedSourceFile(sourceRel) {
  const source = toPackageSourcePath(sourceRel);
  return TOOLKIT_SOURCE_RELATIVE_PATHS.some(path => source === toPackageSourcePath(path) || source.startsWith(`${toPackageSourcePath(path)}/`));
}

function packageErrors(root) {
  const errors = [];
  for (const file of markdownFiles(root)) for (const link of links(readFileSync(file, 'utf8'))) {
    if (EXTERNAL.test(link.url)) continue;
    const part = link.url.split('#', 1)[0]; if (!part) continue;
    const target = resolve(dirname(file), part);
    if (!existsSync(target)) errors.push(error(root, file, link, relative(root, target), 'package'));
  }
  return errors;
}

function installedErrorsForPackage(root) {
  const errors = [];
  for (const file of markdownFiles(root)) {
    const sourceRel = relative(root, file).replaceAll('\\', '/');
    if (!installedSourceFile(sourceRel)) continue;
    const installedFile = join(root, INSTALLED_TOOLKIT_ROOT_DIRECTORY, sourceRel);
    for (const link of links(readFileSync(file, 'utf8'))) {
      if (EXTERNAL.test(link.url)) continue;
      const part = link.url.split('#', 1)[0]; if (!part) continue;
      const virtual = resolve(dirname(installedFile), part);
      const virtualRel = relative(root, virtual).replaceAll('\\', '/');
      const underToolkit = virtualRel === INSTALLED_TOOLKIT_ROOT_DIRECTORY || virtualRel.startsWith(`${INSTALLED_TOOLKIT_ROOT_DIRECTORY}/`);
      const sourceTarget = underToolkit ? toPackageSourcePath(virtualRel) : null;
      const validToolkitTarget = sourceTarget && existsSync(join(root, sourceTarget)) && installedSourceFile(sourceTarget);
      // Root-level links must be known target-owned surfaces, not arbitrary filenames (Defect 15).
      const validTargetSurface = !underToolkit && !virtualRel.startsWith('../') && !virtualRel.includes('/') && TARGET_ROOT_FILES.has(virtualRel);
      if (!validToolkitTarget && !validTargetSurface) errors.push(error(root, file, link, virtualRel, 'installed'));
    }
  }
  return errors;
}

function installedErrorsForTarget(root) {
  const installed = join(root, INSTALLED_TOOLKIT_ROOT_DIRECTORY);
  if (!existsSync(installed)) return [];
  const errors = [];
  for (const file of markdownFiles(installed)) for (const link of links(readFileSync(file, 'utf8'))) {
    if (EXTERNAL.test(link.url)) continue;
    const part = link.url.split('#', 1)[0]; if (!part) continue;
    const target = resolve(dirname(file), part);
    if (!existsSync(target)) errors.push(error(root, file, link, relative(root, target), 'installed'));
  }
  return errors;
}

export function validateLinks(rootDir, options = {}) {
  try {
    const source = isPackageSourceRepositoryRoot(rootDir);
    const packageResult = source ? packageErrors(rootDir) : [];
    const installedResult = options.skipInstalledLayout ? [] : source ? installedErrorsForPackage(rootDir) : installedErrorsForTarget(rootDir);
    const unique = new Map();
    for (const item of [...packageResult, ...installedResult]) unique.set(`${item.file}:${item.line}:${item.url}:${item.context}`, item);
    return { errors: [...unique.values()], packageErrors: packageResult, installedErrors: installedResult };
  } catch (cause) {
    return { errors: [{ file: '.', line: 0, url: '', target: '', context: 'validator', message: `link validation failed: ${cause.message}` }], packageErrors: [], installedErrors: [] };
  }
}

export function formatLinkErrors(result) {
  if (!result.errors.length) return ['All Markdown links validate.'];
  return [`Found ${result.errors.length} broken link(s):`, ...result.errors.map(item => `  ${item.context}: ${item.file}:${item.line} ${item.url} -> ${item.target}`)];
}
