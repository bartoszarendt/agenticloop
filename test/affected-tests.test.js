import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { git, initTestGitRepository } from './helpers/git-fixture.js';

import {
  buildDependencyGraph,
  parseLocalDataReads,
  parseLocalImports,
  selectAffectedTests,
} from '../scripts/affected-tests.js';

const AFFECTED_SCRIPT = readFileSync(new URL('../scripts/affected-tests.js', import.meta.url), 'utf8');
const REPO_ROOT = new URL('../', import.meta.url);

function repositorySources() {
  const sources = new Map();
  const walk = directory => {
    for (const entry of readdirSync(new URL(directory, REPO_ROOT), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:js|mjs|cjs|ts|mts|cts)$/.test(entry.name)) {
        sources.set(path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
      }
    }
  };
  for (const directory of ['src', 'scripts', 'test']) walk(directory);
  return sources;
}

function createAffectedTestsRepository() {
  const root = mkdtempSync(join(tmpdir(), 'agenticloop-affected-tests-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'affected-tests.js'), AFFECTED_SCRIPT, 'utf8');
  writeFileSync(join(root, 'src', 'core.js'), 'export const value = 1;\n', 'utf8');
  writeFileSync(join(root, 'src', 'api.js'), "export { value } from './core.js';\n", 'utf8');
  writeFileSync(join(root, 'test', 'api.test.js'), [
    "import { writeFileSync } from 'node:fs';",
    "import { value } from '../src/api.js';",
    "writeFileSync('executed.marker', String(value));",
  ].join('\n'), 'utf8');
  writeFileSync(join(root, 'test', 'other.test.js'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('executed.marker', 'other');\n", 'utf8');
  writeFileSync(join(root, 'test', 'dynamic.test.js'), "readFileSync(join(REPO_ROOT, assetPath));\n", 'utf8');
  writeFileSync(join(root, 'LICENSE'), 'initial\n', 'utf8');
  initTestGitRepository(root, { quiet: true });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial fixture']);
  return root;
}

function listAffected(root, flag) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'affected-tests.js'), flag], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('affected test dependency graph', () => {
  it('builds reverse edges for static imports, re-exports, and literal dynamic imports', () => {
    const sources = {
      'src/entry.js': "export { value } from './middle.js';",
      'src/middle.js': "export async function load() { return import('./leaf.js', { with: { type: 'javascript' } }); }",
      'src/leaf.js': 'export const value = 1;',
      'test/entry.test.js': "import '../src/entry.js';",
    };

    assert.deepEqual(parseLocalImports(sources['src/entry.js']).specifiers, ['./middle.js']);
    assert.deepEqual(parseLocalImports("const fixture = \"import './not-code.js'\";").specifiers, []);
    const graph = buildDependencyGraph(sources);
    assert.deepEqual([...graph.dependents.get('src/leaf.js')], ['src/middle.js']);
    assert.deepEqual([...graph.dependents.get('src/middle.js')], ['src/entry.js']);
    assert.deepEqual([...graph.dependents.get('src/entry.js')], ['test/entry.test.js']);
    assert.deepEqual(graph.ambiguities, []);
  });

  it('selects tests transitively through production modules', () => {
    const sources = {
      'src/core.js': 'export const core = true;',
      'src/api.js': "export { core } from './core.js';",
      'test/api.test.js': "import '../src/api.js';",
      'test/other.test.js': "import assert from 'node:assert';",
    };
    const graph = buildDependencyGraph(sources);
    const result = selectAffectedTests({
      changedFiles: ['src/core.js'],
      testFiles: ['test/api.test.js', 'test/other.test.js'],
      graph,
    });

    assert.deepEqual(result.selectedTests, ['test/api.test.js']);
    assert.deepEqual(result.reasons.get('test/api.test.js'), ['depends on src/core.js']);
    assert.equal(result.fallback, null);
  });

  it('selects every test that imports a changed helper', () => {
    const sources = {
      'test/support/helper.js': 'export const fixture = true;',
      'test/one.test.js': "import { fixture } from './support/helper.js';",
      'test/two.test.js': "import { fixture } from './support/helper.js';",
      'test/three.test.js': "import assert from 'node:assert';",
    };
    const graph = buildDependencyGraph(sources);
    const result = selectAffectedTests({
      changedFiles: ['test/support/helper.js'],
      testFiles: Object.keys(sources).filter(file => file.includes('.test.')),
      graph,
    });

    assert.deepEqual(result.selectedTests, ['test/one.test.js', 'test/two.test.js']);
  });

  it('always selects a changed untracked test', () => {
    const sources = {
      'src/core.js': 'export const core = true;',
      'test/new.test.js': "import '../src/core.js';",
    };
    const graph = buildDependencyGraph(sources);
    const result = selectAffectedTests({
      changedFiles: ['test/new.test.js'],
      testFiles: ['test/new.test.js'],
      graph,
    });

    assert.deepEqual(result.selectedTests, ['test/new.test.js']);
    assert.deepEqual(result.reasons.get('test/new.test.js'), ['test file changed']);
  });

  it('falls back explicitly for central metadata and for relevant graph ambiguity', () => {
    const tests = ['test/one.test.js', 'test/two.test.js'];
    const cleanGraph = buildDependencyGraph({
      'test/one.test.js': "import assert from 'node:assert';",
      'test/two.test.js': "import assert from 'node:assert';",
    });
    const graph = buildDependencyGraph({
      "src/core.js": "import './missing.js'; export const core = true;",
      'test/one.test.js': "import '../src/core.js';",
      'test/two.test.js': "import assert from 'node:assert';",
    });

    for (const central of ['package.json', 'package-lock.json', 'config.json', 'scripts/test-groups.js']) {
      const metadata = selectAffectedTests({ changedFiles: [central], testFiles: tests, graph: cleanGraph });
      assert.deepEqual(metadata.selectedTests, tests, central);
      assert.match(metadata.fallback, /central test metadata changed/, central);
    }

    const ambiguity = selectAffectedTests({ changedFiles: ['src/core.js'], testFiles: tests, graph });
    assert.deepEqual(ambiguity.selectedTests, tests);
    assert.match(ambiguity.fallback, /dependency graph ambiguity/);
  });

  it('falls back conservatively for shared test helpers', () => {
    const tests = ['test/one.test.js', 'test/two.test.js'];
    const graph = buildDependencyGraph(Object.fromEntries(tests.map(file => [file, "import assert from 'node:assert';"])));
    const result = selectAffectedTests({
      changedFiles: ['test/helpers/task-fixture.js'],
      testFiles: tests,
      graph,
    });
    assert.deepEqual(result.selectedTests, [...tests].sort());
    assert.match(result.fallback, /shared fixture/);
  });

  it('widens adapter and template changes to their conservative cohorts', () => {
    const tests = [
      'test/adapter-opencode.test.js',
      'test/init.test.js',
      'test/template-contract.test.js',
      'test/unrelated.test.js',
    ];
    const graph = buildDependencyGraph({
      'src/adapters/shared.js': 'export const shared = true;',
      ...Object.fromEntries(tests.map(file => [file, "import assert from 'node:assert';"])),
    });

    const adapter = selectAffectedTests({ changedFiles: ['src/adapters/shared.js'], testFiles: tests, graph });
    assert.deepEqual(adapter.selectedTests, ['test/adapter-opencode.test.js']);
    assert.equal(adapter.fallback, null);

    const template = selectAffectedTests({ changedFiles: ['agenticloop.template.json'], testFiles: tests, graph });
    assert.deepEqual(template.selectedTests, [
      'test/adapter-opencode.test.js',
      'test/init.test.js',
      'test/template-contract.test.js',
    ]);
  });

  it('discovers literal data assets read with readFileSync, new URL, fileURLToPath, and join(REPO_ROOT)', () => {
    const sources = {
      'src/loader.js': [
        "readFileSync('./assets/direct.json');",
        "readFileSync(new URL('../docs/url.json', import.meta.url));",
        "readFileSync(fileURLToPath(new URL('../docs/file-url.json', import.meta.url)));",
        "readFileSync(join(REPO_ROOT, 'templates', 'root.json'));",
      ].join('\n'),
      'test/loader.test.js': "import '../src/loader.js';",
    };
    const graph = buildDependencyGraph(sources, {
      knownFiles: ['src/assets/direct.json', 'docs/file-url.json', 'docs/url.json', 'templates/root.json'],
    });

    assert.deepEqual(parseLocalDataReads(sources['src/loader.js']).reads, [
      { path: '../docs/url.json', fromRoot: false },
      { path: '../docs/file-url.json', fromRoot: false },
      { path: './assets/direct.json', fromRoot: false },
      { path: 'templates/root.json', fromRoot: true },
    ].sort((left, right) => left.path.localeCompare(right.path)));
    for (const changed of ['src/assets/direct.json', 'docs/file-url.json', 'docs/url.json', 'templates/root.json']) {
      const result = selectAffectedTests({ changedFiles: [changed], testFiles: ['test/loader.test.js'], graph });
      assert.deepEqual(result.selectedTests, ['test/loader.test.js'], changed);
      assert.equal(result.fallback, null, changed);
    }
  });

  it('infers only direct literal repository asset expressions', () => {
    const sources = {
      'src/loader.js': [
        "readFileSync('./assets/direct.json');",
        "readFileSync(new URL('../docs/url.json', import.meta.url));",
        "readFileSync(resolve(REPO_ROOT, 'templates', 'root.json'));",
      ].join('\n'),
      'test/loader.test.js': "import '../src/loader.js';",
    };
    const graph = buildDependencyGraph(sources, {
      knownFiles: ['src/assets/direct.json', 'docs/url.json', 'templates/root.json'],
    });

    assert.deepEqual(graph.ambiguities, []);
    const result = selectAffectedTests({
      changedFiles: ['src/assets/direct.json'], testFiles: ['test/loader.test.js'], graph,
    });
    assert.deepEqual(result.selectedTests, ['test/loader.test.js']);
    assert.equal(result.fallback, null);
  });

  it('discovers only exact literal URL, join, resolve, and copy source expressions', () => {
    const sources = {
      'src/loader.js': [
        "readFileSync(new URL('../memory/url.md', import.meta.url));",
        "readFileSync(join(REPO_ROOT, 'memory', 'join.md'));",
        "readFileSync(resolve(REPO_ROOT, 'memory', 'resolve.md'));",
        "copyFileSync(new URL('../memory/copy-url.md', import.meta.url), destination);",
        "copyFileSync(fileURLToPath(new URL('../memory/copy-file-url.md', import.meta.url)), destination);",
        "copyFileSync(join(REPO_ROOT, 'memory', 'copy-join.md'), destination);",
        "copyFileSync(resolve(REPO_ROOT, 'memory', 'copy-resolve.md'), destination);",
      ].join('\n'),
      'test/loader.test.js': "import '../src/loader.js';",
    };
    const assets = [
      'memory/url.md', 'memory/join.md', 'memory/resolve.md',
      'memory/copy-url.md', 'memory/copy-file-url.md', 'memory/copy-join.md', 'memory/copy-resolve.md',
    ];
    const graph = buildDependencyGraph(sources, { knownFiles: assets });

    assert.deepEqual(graph.ambiguities, []);
    for (const asset of assets) {
      const result = selectAffectedTests({ changedFiles: [asset], testFiles: ['test/loader.test.js'], graph });
      assert.deepEqual(result.selectedTests, ['test/loader.test.js'], asset);
      assert.equal(result.fallback, null, asset);
    }
  });

  it('treats dynamic assignment and parameter shadowing as unresolved data reads', () => {
    const source = [
      "const asset = './assets/static.json';",
      "let assigned = './assets/first.json';",
      "assigned = './assets/second.json';",
      'readFileSync(assigned);',
      'function load(asset) { readFileSync(asset); }',
      "load('./assets/caller.json');",
    ].join('\n');

    assert.deepEqual(parseLocalDataReads(source).ambiguous, ['non-literal readFileSync path']);
    const tests = ['test/loader.test.js', 'test/other.test.js'];
    const graph = buildDependencyGraph({
      'src/loader.js': source,
      'test/loader.test.js': "import '../src/loader.js';",
      'test/other.test.js': "import assert from 'node:assert';",
    });
    const result = selectAffectedTests({ changedFiles: ['src/loader.js'], testFiles: tests, graph });
    assert.deepEqual(result.selectedTests, tests);
    assert.match(result.fallback, /non-literal runtime data read/);
  });

  it('falls back when a changed static asset shares a consumer with an unresolved dynamic asset read', () => {
    const tests = ['test/loader.test.js', 'test/other.test.js'];
    const graph = buildDependencyGraph({
      'src/loader.js': [
        "readFileSync('./assets/data.json');",
        'readFileSync(resolve(REPO_ROOT, dynamicAsset));',
      ].join('\n'),
      'test/loader.test.js': "import '../src/loader.js';",
      'test/other.test.js': "import assert from 'node:assert';",
    }, { knownFiles: ['src/assets/data.json'] });
    const result = selectAffectedTests({
      changedFiles: ['src/assets/data.json'], testFiles: tests, graph,
    });

    assert.deepEqual(result.selectedTests, tests);
    assert.match(result.fallback, /non-literal repository-relative data read/);
  });

  it('does not let opaque runtime paths or a different dynamic directory poison a literal asset', () => {
    const tests = ['test/loader.test.js', 'test/other.test.js'];
    const graph = buildDependencyGraph({
      'src/loader.js': [
        "readFileSync('./assets/data.json');",
        'readFileSync(fixture.taskPath);',
        "readFileSync(resolve(REPO_ROOT, 'docs', dynamicDocument));",
      ].join('\n'),
      'test/loader.test.js': "import '../src/loader.js';",
      'test/other.test.js': "import assert from 'node:assert';",
    }, { knownFiles: ['src/assets/data.json'] });
    const result = selectAffectedTests({
      changedFiles: ['src/assets/data.json'], testFiles: tests, graph,
    });

    assert.deepEqual(result.selectedTests, ['test/loader.test.js']);
    assert.equal(result.fallback, null);
    assert.deepEqual(graph.ambiguities.map(entry => [entry.specifier, entry.pathScope]), [
      ['non-literal join(REPO_ROOT, ...)', 'docs/'],
      ['non-literal readFileSync path', null],
    ]);
  });

  it('only falls back for ambiguity relevant to the changed dependency path', () => {
    const tests = ['test/literal.test.js', 'test/dynamic.test.js', 'test/other.test.js'];
    const graph = buildDependencyGraph({
      'test/literal.test.js': "readFileSync('../assets/data.json');",
      'test/dynamic.test.js': 'readFileSync(resolve(REPO_ROOT, dynamicAsset));',
      'test/other.test.js': "import assert from 'node:assert';",
    }, { knownFiles: ['assets/data.json'] });
    const result = selectAffectedTests({
      changedFiles: ['assets/data.json'], testFiles: tests, graph,
    });

    assert.deepEqual(result.selectedTests, ['test/literal.test.js']);
    assert.equal(result.fallback, null);

    const dynamic = selectAffectedTests({
      changedFiles: ['test/dynamic.test.js'], testFiles: tests, graph,
    });
    assert.deepEqual(dynamic.selectedTests, [...tests].sort());
    assert.match(dynamic.fallback, /non-literal repository-relative data read/);
  });

  it('fails safe for resolve(REPO_ROOT), variable-derived, and templated data reads', () => {
    const sources = {
      'src/loader.js': [
        'readFileSync(resolve(REPO_ROOT, pathFromConfig));',
        'readFileSync(join(REPO_ROOT, `assets/${assetName}.json`));',
        'readFileSync(new URL(`./assets/${assetName}.json`, import.meta.url));',
        'readFileSync(`./assets/${assetName}.json`);',
      ].join('\n'),
      'test/loader.test.js': "import '../src/loader.js';",
      'test/other.test.js': "import assert from 'node:assert';",
    };
    const graph = buildDependencyGraph(sources);
    const result = selectAffectedTests({ changedFiles: ['src/loader.js'], testFiles: ['test/loader.test.js', 'test/other.test.js'], graph });

    assert.deepEqual(result.selectedTests, ['test/loader.test.js', 'test/other.test.js']);
    assert.match(result.fallback, /non-literal repository-relative data read/);
    assert.deepEqual(parseLocalDataReads(sources['src/loader.js']).ambiguous, [
      'non-literal join(REPO_ROOT, ...)',
      'non-literal new URL path relative to import.meta.url',
      'non-literal template repository-relative data read',
    ]);
  });

  it('routes skill changes to validation and host-skill consumers', () => {
    const tests = ['test/validate-skills.test.js', 'test/host-skill-surface.test.js', 'test/unrelated.test.js'];
    const graph = buildDependencyGraph(Object.fromEntries(tests.map(file => [file, ''])));
    const result = selectAffectedTests({ changedFiles: ['skills/example/SKILL.md'], testFiles: tests, graph });

    assert.deepEqual(result.selectedTests, ['test/host-skill-surface.test.js', 'test/validate-skills.test.js']);
    assert.equal(result.fallback, null);
  });

  it('routes task-record changes to dispatch-envelope consumers', () => {
    const tests = ['test/dispatch-envelope-handoff.test.js', 'test/dispatch-envelope-blocked.test.js', 'test/task-contract-hardening.test.js'];
    const graph = buildDependencyGraph(Object.fromEntries(tests.map(file => [file, ''])));
    const result = selectAffectedTests({ changedFiles: ['.agenticloop/tasks/T-001.md'], testFiles: tests, graph });

    assert.deepEqual(result.selectedTests, ['test/dispatch-envelope-blocked.test.js', 'test/dispatch-envelope-handoff.test.js']);
    assert.equal(result.fallback, null);
  });

  it('falls back for unknown tracked and nonignored untracked paths even when the graph has nodes', () => {
    const tests = ['test/new.test.js', 'test/other.test.js'];
    const sources = Object.fromEntries(tests.map(file => [file, '']));
    const trackedGraph = buildDependencyGraph(sources, { knownFiles: ['LICENSE'] });
    const untrackedGraph = buildDependencyGraph(sources, { knownFiles: ['scratch.asset'] });
    const graph = buildDependencyGraph(sources);
    const tracked = selectAffectedTests({ changedFiles: ['LICENSE'], testFiles: tests, graph: trackedGraph });
    const untracked = selectAffectedTests({ changedFiles: ['scratch.asset'], untrackedFiles: ['scratch.asset'], testFiles: tests, graph: untrackedGraph });
    const test = selectAffectedTests({ changedFiles: ['test/new.test.js'], untrackedFiles: ['test/new.test.js'], testFiles: tests, graph });

    assert.ok(trackedGraph.dependencies.has('LICENSE'));
    assert.ok(untrackedGraph.dependencies.has('scratch.asset'));
    assert.match(tracked.fallback, /unknown changed path/);
    assert.match(untracked.fallback, /unknown nonignored untracked path/);
    assert.deepEqual(test.selectedTests, ['test/new.test.js']);
    assert.equal(test.fallback, null);
  });

  it('selects actual task-record consumers from the repository graph', () => {
    const sources = repositorySources();
    const graph = buildDependencyGraph(sources, { knownFiles: ['memory/task-record.md'] });
    const tests = [...sources.keys()].filter(file => /^test\/.*\.test\.js$/.test(file));
    const result = selectAffectedTests({
      changedFiles: ['memory/task-record.md'], testFiles: tests, graph,
    });

    assert.equal(result.fallback, null);
    assert.ok(result.selectedTests.length < tests.length);
    assert.ok(result.selectedTests.includes('test/closeout-prepare.test.js'));
    assert.ok(result.selectedTests.includes('test/parallel-ownership.test.js'));
  });
});

describe('affected test CLI changed-file discovery', () => {
  it('discovers a tracked unknown path and lists the full fallback without executing tests', () => {
    const root = createAffectedTestsRepository();
    try {
      writeFileSync(join(root, 'LICENSE'), 'changed\n', 'utf8');
      const result = listAffected(root, '--list');

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Changed files \(1\):\n  LICENSE/);
      assert.match(result.stdout, /Full-suite fallback: unknown changed path \(LICENSE\)/);
      assert.equal(existsSync(join(root, 'executed.marker')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers every nonignored untracked path and dry-runs without executing tests', () => {
    const root = createAffectedTestsRepository();
    try {
      writeFileSync(join(root, 'scratch.asset'), 'untracked\n', 'utf8');
      const result = listAffected(root, '--dry-run');

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Changed files \(1\):\n  scratch\.asset/);
      assert.match(result.stdout, /Full-suite fallback: unknown nonignored untracked path \(scratch\.asset\)/);
      assert.equal(existsSync(join(root, 'executed.marker')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects only a transitive production consumer under real changed-file discovery', () => {
    const root = createAffectedTestsRepository();
    try {
      writeFileSync(join(root, 'src', 'core.js'), 'export const value = 2;\n', 'utf8');
      const result = listAffected(root, '--list');

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Selected tests \(1\):\n  test\/api\.test\.js/);
      assert.match(result.stdout, /Full-suite fallback: none/);
      assert.doesNotMatch(result.stdout, /test\/dynamic\.test\.js: full-suite fallback/);
      assert.equal(existsSync(join(root, 'executed.marker')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
