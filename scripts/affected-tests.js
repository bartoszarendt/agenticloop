#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const SHARED_FIXTURES = /^(?:fixtures?\/|test\/(?:helpers|fixtures|__fixtures__)\/)/;
const FULL_SUITE_PATHS = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|config\.json|scripts\/(?:affected-tests|profile-tests|run-tests|test-groups)\.js)$/;

// Non-JS changes are deliberately routed through explicit, reviewable cohorts.
// Everything else is unknown and therefore runs the full suite. The test-name
// patterns name the consumers of each shipped surface, rather than guessing from
// the changed filename at runtime.
const COHORTS = Object.freeze([
  { name: 'adapters', paths: /^src\/adapters\//, tests: /adapter/i },
  { name: 'bin and CLI', paths: /^(?:bin\/|src\/(?:cli|.*-cli)[^/]*\.(?:js|mjs|cjs|ts|mts|cts)$)/, tests: /(?:cli|command|registry|safety|target-resolution)/i },
  { name: 'package and install', paths: /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|\.npmignore|manifest\.json)/, tests: /(?:packed-package|plugin-packaging|init|setup|install)/i },
  { name: 'skills', paths: /^skills\//, tests: /(?:validate-skills|host-skill-surface)/i },
  { name: 'agents', paths: /^agents\//, tests: /(?:host-role-capabilities|adapter|generated-artifacts)/i },
  { name: 'templates and memory', paths: /^(?:agenticloop\.template\.json|templates?\/|backends\/|commands\/|memory\/|config\.json)/, tests: /(?:adapter|config|generat|init|packag|template)/i },
  { name: 'docs and guidance', paths: /^(?:docs\/|README\.md|AGENTIC_LOOP\.md|CHANGELOG\.md)/, tests: /(?:guidance|markdown|documentation|activation-assurance-docs)/i },
  { name: 'task records', paths: /^\.agenticloop\/tasks\//, tests: /^dispatch-envelope-.*\.test\.js$/i },
]);

export function normalizePath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function withoutComments(source) {
  let output = '';
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        output += char;
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'code' && char === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line';
      continue;
    }
    if (state === 'code' && char === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block';
      continue;
    }

    output += char;
    if (state === 'code' && (char === "'" || char === '"' || char === '`')) {
      state = char;
    } else if (state !== 'code' && char === '\\') {
      if (index + 1 < source.length) output += source[++index];
    } else if (state !== 'code' && char === state) {
      state = 'code';
    }
  }
  return output;
}

function codePositions(source) {
  const positions = new Uint8Array(source.length);
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state !== 'code') {
      if (char === '\\') index += 1;
      else if (char === state) state = 'code';
      continue;
    }
    if (char === '/' && next === '/') {
      index += 1;
      state = 'line';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 1;
      state = 'block';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      state = char;
      continue;
    }
    positions[index] = 1;
  }
  return positions;
}

/** Return relative specifiers from static imports/exports and literal imports. */
export function parseLocalImports(source) {
  const code = withoutComments(source);
  const positions = codePositions(source);
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s+from\s*)?(['"])([^'"\r\n]+)\1/g,
    /\bexport\s+(?:\*\s*(?:as\s+[$\w]+\s*)?|\{[^}]*\})\s+from\s*(['"])([^'"\r\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1(?:\s*,\s*\{[^)]*\})?\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (!positions[match.index]) continue;
      const specifier = match[2];
      if (specifier.startsWith('./') || specifier.startsWith('../')) specifiers.add(specifier);
    }
  }

  const ambiguous = [...code.matchAll(/\bimport\s*\(\s*`([^`]*)`(?:\s*,\s*\{[^)]*\})?\s*\)/g)]
    .filter(match => positions[match.index])
    .map(match => match[1])
    .filter(value => (value.startsWith('./') || value.startsWith('../')) && value.includes('${'));

  return {
    specifiers: [...specifiers].sort(),
    ambiguous,
    ambiguityDetails: ambiguous.map(specifier => ({
      specifier,
      pathPrefix: specifier.slice(0, specifier.indexOf('${')),
      fromRoot: false,
    })),
  };
}

function literalArgumentPrefix(argumentsSource) {
  const parts = [];
  let remaining = argumentsSource.trim();
  while (remaining.length > 0) {
    const match = remaining.match(/^(['"])([^'"\r\n]+)\1\s*(?:,\s*|$)/);
    if (!match) break;
    parts.push(match[2]);
    remaining = remaining.slice(match[0].length);
  }
  return parts.length > 0 ? `${parts.join('/').replace(/\/$/, '')}/` : '';
}

function templatePrefix(value) {
  const interpolation = value.indexOf('${');
  return interpolation === -1 ? null : value.slice(0, interpolation);
}

/**
 * Discover repository-relative data reads without interpreting arbitrary JS.
 * Supported literal source forms are readFileSync('./file'),
 * readFileSync(new URL('./file', import.meta.url)),
 * readFileSync(fileURLToPath(new URL('./file', import.meta.url))),
 * readFileSync(join(REPO_ROOT, 'directory', 'file')),
 * readFileSync(resolve(REPO_ROOT, 'directory', 'file')), and the matching
 * copyFileSync source forms. Dynamic forms are recorded as ambiguities so
 * selection fails safe rather than silently omitting consumers of an asset. URL,
 * join, and resolve expressions outside these consumers are path construction,
 * not data reads, and deliberately do not poison selection.
 */
export function parseLocalDataReads(source) {
  const code = withoutComments(source);
  const positions = codePositions(source);
  const reads = new Set();
  const ambiguous = [];
  const ambiguityDetails = [];
  const add = (path, fromRoot) => reads.add(JSON.stringify({ path, fromRoot }));
  const addAmbiguity = (specifier, pathPrefix = null, fromRoot = false) => {
    ambiguous.push(specifier);
    ambiguityDetails.push({ specifier, pathPrefix, fromRoot });
  };
  const consumers = '(?:readFileSync|copyFileSync)';
  for (const match of code.matchAll(new RegExp(`\\b${consumers}\\s*\\(\\s*(['"])([^'"\\r\\n]+)\\1`, 'g'))) {
    if (positions[match.index]) add(match[2], false);
  }
  for (const match of code.matchAll(new RegExp(`\\b${consumers}\\s*\\(\\s*new\\s+URL\\s*\\(\\s*(['"])([^'"\\r\\n]+)\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`, 'g'))) {
    if (positions[match.index]) add(match[2], false);
  }
  for (const match of code.matchAll(new RegExp(`\\b${consumers}\\s*\\(\\s*fileURLToPath\\s*\\(\\s*new\\s+URL\\s*\\(\\s*(['"])([^'"\\r\\n]+)\\1\\s*,\\s*import\\.meta\\.url\\s*\\)\\s*\\)`, 'g'))) {
    if (positions[match.index]) add(match[2], false);
  }
  for (const match of code.matchAll(new RegExp(`\\b${consumers}\\s*\\(\\s*(?:join|resolve)\\s*\\(\\s*REPO_ROOT\\s*,\\s*([^)]*)\\)`, 'g'))) {
    if (!positions[match.index]) continue;
    const parts = [...match[1].matchAll(/(['"])([^'"\r\n]+)\1/g)];
    const literalOnly = parts.length > 0 && parts.map(part => part[0]).join(',').replaceAll(/\s+/g, '') === match[1].replaceAll(/\s+/g, '');
    if (literalOnly) add(parts.map(part => part[2]).join('/'), true);
    else addAmbiguity('non-literal join(REPO_ROOT, ...)', literalArgumentPrefix(match[1]), true);
  }

  for (const match of code.matchAll(new RegExp(`\\b${consumers}\\s*\\(\\s*new\\s+URL\\s*\\(\\s*(?!['"])[^,]+,\\s*import\\.meta\\.url\\s*\\)`, 'g'))) {
    if (!positions[match.index]) continue;
    const expression = match[0].match(/new\s+URL\s*\(\s*([^,]+)/)?.[1]?.trim() ?? '';
    const prefix = expression.startsWith('`') ? templatePrefix(expression.slice(1, -1)) : '';
    addAmbiguity('non-literal new URL path relative to import.meta.url', prefix, false);
  }
  for (const match of code.matchAll(new RegExp(`\\b${consumers}\\s*\\(\\s*fileURLToPath\\s*\\(\\s*new\\s+URL\\s*\\(\\s*(?!['"])[^,]+,\\s*import\\.meta\\.url\\s*\\)\\s*\\)`, 'g'))) {
    if (!positions[match.index]) continue;
    const expression = match[0].match(/new\s+URL\s*\(\s*([^,]+)/)?.[1]?.trim() ?? '';
    const prefix = expression.startsWith('`') ? templatePrefix(expression.slice(1, -1)) : '';
    addAmbiguity('non-literal new URL path relative to import.meta.url', prefix, false);
  }
  for (const match of code.matchAll(new RegExp(`\\b${consumers}\\s*\\(\\s*` + '`([^`]*)`', 'g'))) {
    if (positions[match.index] && match[1].includes('${')) {
      addAmbiguity('non-literal template repository-relative data read', templatePrefix(match[1]), false);
    }
  }
  for (const match of code.matchAll(new RegExp(`\\b${consumers}\\s*\\(\\s*([^\\s'"\`][^,)]*)`, 'g'))) {
    if (!positions[match.index]) continue;
    const expression = match[1].trim();
    if (/^(?:new\s+URL|fileURLToPath\s*\(\s*new\s+URL|join\s*\(\s*REPO_ROOT|resolve\s*\(\s*REPO_ROOT)/.test(expression)) continue;
    // A plain runtime variable may point at a temporary or external path. It
    // carries no evidence that a repository asset is hidden behind the read.
    addAmbiguity('non-literal readFileSync path');
  }

  return {
    reads: [...reads].map(value => JSON.parse(value)).sort((left, right) => left.path.localeCompare(right.path)),
    ambiguous: [...new Set(ambiguous)].sort(),
    ambiguityDetails: [...new Map(ambiguityDetails.map(detail => [JSON.stringify(detail), detail])).values()]
      .sort((left, right) => left.specifier.localeCompare(right.specifier)),
  };
}

/** Resolve a local specifier against repository-relative known files. */
export function resolveLocalImport(importer, specifier, knownFiles) {
  const base = normalizePath(posix.normalize(posix.join(posix.dirname(importer), specifier)));
  const candidates = extname(base)
    ? [base]
    : [
        base,
        ...[...CODE_EXTENSIONS].map(extension => `${base}${extension}`),
        ...[...CODE_EXTENSIONS].map(extension => `${base}/index${extension}`),
      ];
  const matches = candidates.filter(candidate => knownFiles.has(candidate));
  return matches.length === 1
    ? { file: matches[0], ambiguous: false }
    : { file: null, ambiguous: matches.length > 1 };
}

function resolveLocalDataRead(importer, read, knownFiles) {
  const candidate = normalizePath(posix.normalize(read.fromRoot
    ? read.path
    : posix.join(posix.dirname(importer), read.path)));
  return knownFiles.has(candidate) ? candidate : null;
}

function resolveAmbiguityScope(importer, detail) {
  if (detail.pathPrefix === null) return null;
  if (detail.pathPrefix === '') return '';
  const normalized = normalizePath(posix.normalize(detail.fromRoot
    ? detail.pathPrefix
    : posix.join(posix.dirname(importer), detail.pathPrefix)));
  return normalized === '.' ? '' : normalized;
}

/** Build forward and reverse local-import graphs from a path-to-source map. */
export function buildDependencyGraph(sources, options = {}) {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources);
  const normalizedSources = new Map(entries.map(([file, source]) => [normalizePath(file), source]));
  const knownFiles = new Set([
    ...normalizedSources.keys(),
    ...(options.knownFiles ?? []).map(normalizePath),
  ]);
  const dependencies = new Map([...knownFiles].map(file => [file, new Set()]));
  const dependents = new Map([...knownFiles].map(file => [file, new Set()]));
  const dataFiles = new Set();
  const ambiguities = [];

  for (const [importer, source] of normalizedSources) {
    const parsed = parseLocalImports(source);
    for (const detail of parsed.ambiguityDetails) {
      ambiguities.push({
        importer,
        specifier: detail.specifier,
        kind: 'import',
        pathScope: resolveAmbiguityScope(importer, detail),
        reason: 'non-literal local dynamic import',
      });
    }
    for (const specifier of parsed.specifiers) {
      const resolved = resolveLocalImport(importer, specifier, knownFiles);
      if (!resolved.file) {
        ambiguities.push({
          importer,
          specifier,
          kind: 'import',
          reason: resolved.ambiguous ? 'multiple matching files' : 'unresolved local import',
        });
        continue;
      }
      dependencies.get(importer).add(resolved.file);
      dependents.get(resolved.file).add(importer);
    }
    const dataReads = parseLocalDataReads(source);
    for (const detail of dataReads.ambiguityDetails) {
      ambiguities.push({
        importer,
        specifier: detail.specifier,
        kind: 'data-read',
        pathScope: resolveAmbiguityScope(importer, detail),
        reason: detail.pathPrefix === null
          ? 'non-literal runtime data read'
          : 'non-literal repository-relative data read',
      });
    }
    for (const read of dataReads.reads) {
      const resolved = resolveLocalDataRead(importer, read, knownFiles);
      if (!resolved) {
        ambiguities.push({ importer, specifier: read.path, kind: 'data-read', reason: 'unresolved literal repository-relative data read' });
        continue;
      }
      dependencies.get(importer).add(resolved);
      dependents.get(resolved).add(importer);
      dataFiles.add(resolved);
    }
  }

  return { dependencies, dependents, dataFiles, ambiguities };
}

function isTestFile(file) {
  return /^test\/.*\.test\.(?:js|mjs|cjs|ts|mts|cts)$/.test(file);
}

function isCodePath(file) {
  return /^(?:src|scripts|test)\//.test(file) && CODE_EXTENSIONS.has(extname(file));
}

function addReason(reasons, test, reason) {
  if (!reasons.has(test)) reasons.set(test, new Set());
  reasons.get(test).add(reason);
}

function fallbackToAll(selected, reasons, tests, reason) {
  for (const test of tests) {
    selected.add(test);
    addReason(reasons, test, `full-suite fallback: ${reason}`);
  }
  return reason;
}

function matchingCohorts(file) {
  return COHORTS.filter(cohort => cohort.paths.test(file));
}

function isRecognizedPath(file, graph) {
  return isCodePath(file) || isTestFile(file) || FULL_SUITE_PATHS.test(file) || SHARED_FIXTURES.test(file) ||
    matchingCohorts(file).length > 0 || graph.dataFiles?.has(file);
}

function ambiguityMatchesPath(ambiguity, file) {
  if (ambiguity.pathScope === null || ambiguity.pathScope === undefined) return false;
  if (ambiguity.pathScope === '') return true;
  return file === ambiguity.pathScope || file.startsWith(ambiguity.pathScope.endsWith('/')
    ? ambiguity.pathScope
    : `${ambiguity.pathScope}/`) || file.startsWith(ambiguity.pathScope);
}

function relevantAmbiguity(graph, changed, affected) {
  return graph.ambiguities.find(ambiguity =>
    changed.some(file => ambiguity.importer === file) ||
    (affected.has(ambiguity.importer) && changed.some(file =>
      graph.dependencies.get(ambiguity.importer)?.has(file) && ambiguityMatchesPath(ambiguity, file)
    ))
  );
}

/** Select affected tests using a reverse dependency graph and safety policies. */
export function selectAffectedTests({ changedFiles, testFiles, graph, untrackedFiles = [] }) {
  const changed = [...new Set(changedFiles.map(normalizePath))].sort();
  const tests = [...new Set(testFiles.map(normalizePath))].sort();
  const testSet = new Set(tests);
  const selected = new Set();
  const reasons = new Map();
  const affected = new Set(changed);

  for (const start of changed) {
    if (testSet.has(start) && isTestFile(start)) {
      selected.add(start);
      addReason(reasons, start, 'test file changed');
    }

    const visited = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const dependent of graph.dependents.get(current) ?? []) {
        if (visited.has(dependent)) continue;
        visited.add(dependent);
        queue.push(dependent);
        affected.add(dependent);
        if (testSet.has(dependent) && isTestFile(dependent)) {
          selected.add(dependent);
          addReason(reasons, dependent, `depends on ${start}`);
        }
      }
    }
  }

  const fixture = changed.find(file => SHARED_FIXTURES.test(file));
  const central = changed.find(file => FULL_SUITE_PATHS.test(file));
  const untracked = new Set(untrackedFiles.map(normalizePath));
  const unknown = changed.find(file => !untracked.has(file) && !isRecognizedPath(file, graph));
  const unknownUntracked = [...untracked]
    .find(file => !isRecognizedPath(file, graph));
  const changedCode = changed.filter(isCodePath);
  let fallback = null;

  if (unknown) {
    fallback = fallbackToAll(selected, reasons, tests, `unknown changed path (${unknown})`);
  } else if (unknownUntracked) {
    fallback = fallbackToAll(selected, reasons, tests, `unknown nonignored untracked path (${unknownUntracked})`);
  } else if (central) {
    fallback = fallbackToAll(selected, reasons, tests, `central test metadata changed (${central})`);
  } else if (fixture) {
    fallback = fallbackToAll(selected, reasons, tests, `shared fixture changed (${fixture})`);
  } else {
    // A dynamic read in a downstream test is not an ambiguity about every asset
    // imported by that test. Widen only when the changed file is the ambiguous
    // consumer itself or a known direct dependency inside its normalized scope.
    const first = relevantAmbiguity(graph, changed, affected);
    if (first) {
      fallback = fallbackToAll(
        selected,
        reasons,
        tests,
        `dependency graph ambiguity (${first.importer}: ${first.specifier}, ${first.reason})`
      );
    }
  }

  if (!fallback) {
    for (const changedFile of changed) {
      for (const cohort of matchingCohorts(changedFile)) {
        for (const test of tests.filter(file => cohort.tests.test(posix.basename(file)))) {
          selected.add(test);
          addReason(reasons, test, `${cohort.name} cohort widened`);
        }
      }
    }
  }

  if (!fallback && changedCode.length > 0 && selected.size === 0) {
    fallback = fallbackToAll(selected, reasons, tests, 'no test dependency could be determined');
  }

  return {
    changedFiles: changed,
    selectedTests: [...selected].sort(),
    reasons: new Map([...reasons].map(([test, values]) => [test, [...values].sort()])),
    fallback,
  };
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.split('\0').filter(Boolean).map(normalizePath);
}

function collectChangedFiles(root, base) {
  const changed = new Set();
  const add = files => files.forEach(file => changed.add(file));
  if (base) add(runGit(['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`, '--'], root));
  add(runGit(['diff', '--name-only', '-z', '--no-renames', '--cached', '--'], root));
  add(runGit(['diff', '--name-only', '-z', '--no-renames', '--'], root));
  // Collect every nonignored untracked path before applying relevance policy.
  // Filtering here could hide an unrecognized asset and yield an unsafe subset.
  const untrackedFiles = runGit(['ls-files', '--others', '--exclude-standard', '-z'], root);
  add(untrackedFiles);
  return { changedFiles: [...changed].sort(), untrackedFiles };
}

function collectTrackedFiles(root) {
  return runGit(['ls-files', '-z'], root);
}

function discoverCodeFiles(root) {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) files.push(absolute);
    }
  };
  for (const directory of ['src', 'scripts', 'test']) walk(join(root, directory));
  return files.sort();
}

function repoRelative(root, file) {
  return relative(root, file).split(sep).join('/');
}

function parseArguments(argv) {
  let base = null;
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') {
      base = argv[++index];
      if (!base) throw new Error('--base requires a Git revision');
    } else if (argument.startsWith('--base=')) {
      base = argument.slice('--base='.length);
      if (!base) throw new Error('--base requires a Git revision');
    } else if (argument === '--list' || argument === '--dry-run') {
      list = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (base?.startsWith('-')) throw new Error('--base revision cannot start with -');
  return { base, list };
}

function printSelection(selection) {
  process.stdout.write(`Changed files (${selection.changedFiles.length}):\n`);
  process.stdout.write(selection.changedFiles.length ? `${selection.changedFiles.map(file => `  ${file}`).join('\n')}\n` : '  (none)\n');
  process.stdout.write(`Selected tests (${selection.selectedTests.length}):\n`);
  process.stdout.write(selection.selectedTests.length ? `${selection.selectedTests.map(file => `  ${file}`).join('\n')}\n` : '  (none)\n');
  process.stdout.write('Reasons:\n');
  if (selection.selectedTests.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const test of selection.selectedTests) {
      process.stdout.write(`  ${test}: ${selection.reasons.get(test).join('; ')}\n`);
    }
  }
  process.stdout.write(`Full-suite fallback: ${selection.fallback ?? 'none'}\n`);
}

async function main() {
  const { base, list } = parseArguments(process.argv.slice(2));
  const { changedFiles, untrackedFiles } = collectChangedFiles(REPO_ROOT, base);
  const absoluteFiles = discoverCodeFiles(REPO_ROOT);
  const sources = new Map(absoluteFiles.map(file => [repoRelative(REPO_ROOT, file), readFileSync(file, 'utf8')]));
  const knownFiles = new Set([...collectTrackedFiles(REPO_ROOT), ...sources.keys(), ...changedFiles]);
  const graph = buildDependencyGraph(sources, { knownFiles: [...knownFiles] });
  const testFiles = [...sources.keys()].filter(isTestFile);
  const selection = selectAffectedTests({ changedFiles, untrackedFiles, testFiles, graph });
  printSelection(selection);

  if (list || selection.selectedTests.length === 0) return;
  const result = spawnSync(process.execPath, ['--test', ...selection.selectedTests], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`affected-tests failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
