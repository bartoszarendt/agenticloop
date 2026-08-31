import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { applyHydration, planHydration } from '../src/hydration.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');
let root;

before(() => { root = mkdtempSync(join(tmpdir(), 'al-clone-hydration-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

function run(args, cwd, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', ...options });
}

function assertOk(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function git(cwd, args, { ok = true } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (ok) assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function initGit(cwd) {
  git(cwd, ['init', '--initial-branch=main']);
  git(cwd, ['config', 'core.autocrlf', 'false']);
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=Agentic Loop Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'fixture']);
}

function packageSourceFixture() {
  const target = mkdtempSync(join(root, 'package-source-'));
  for (const relPath of [
    'AGENTIC_LOOP.md', 'agents', 'backends', 'skills', 'commands', 'memory',
    'config.json', 'agenticloop.template.json', 'manifest.json', 'package.json', '.gitignore',
  ]) cpSync(join(REPO_ROOT, relPath), join(target, relPath), { recursive: true });
  mkdirSync(join(target, 'bin'), { recursive: true });
  mkdirSync(join(target, 'src'), { recursive: true });
  writeFileSync(join(target, 'bin', 'agenticloop.js'), '#!/usr/bin/env node\n');
  initGit(target);
  return target;
}

function downstreamFixture({ staleCanonical = false } = {}) {
  const target = mkdtempSync(join(root, 'downstream-'));
  assertOk(run(['init', '--target', target, '--adapter', 'opencode'], target));
  assertOk(run(['update', '--target', target, '--repository-only'], target));
  for (const relPath of ['.opencode', '.agenticloop/host-role-capabilities', '.agenticloop/generated-artifacts.json']) {
    rmSync(join(target, ...relPath.split('/')), { recursive: true, force: true });
  }
  if (staleCanonical) writeFileSync(join(target, 'agenticloop', 'AGENTIC_LOOP.md'), 'stale canonical asset\n');
  initGit(target);
  return target;
}

describe('clone-local hydration', () => {
  it('requires one explicit concrete adapter', () => {
    const target = packageSourceFixture();
    const missing = run(['hydrate', '--target', target], target);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /requires exactly one explicit --adapter/);
    const multiple = run(['hydrate', '--target', target, '--adapter', 'opencode', '--adapter', 'codex'], target);
    assert.equal(multiple.status, 2);
  });

  it('hydrates package-source and installed layouts with a local manifest and no tracked changes', () => {
    for (const target of [packageSourceFixture(), downstreamFixture()]) {
      const configPath = join(target, 'agenticloop.json');
      const configBefore = existsSync(configPath) ? readFileSync(configPath) : null;
      const dryRun = run(['hydrate', '--target', target, '--adapter', 'opencode', '--dry-run', '--json'], target);
      assertOk(dryRun);
      assert.equal(existsSync(join(target, '.opencode')), false, 'dry-run must perform zero writes');
      assertOk(run(['hydrate', '--target', target, '--adapter', 'opencode'], target));
      assert.ok(existsSync(join(target, '.agenticloop', 'local', 'generated-artifacts.json')));
      if (configBefore) assert.deepEqual(readFileSync(configPath), configBefore);
      assert.equal(git(target, ['status', '--porcelain']), '');
    }
  });

  it('hydrates every supported host in an installed target without tracked changes', () => {
    for (const adapter of ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']) {
      const target = downstreamFixture();
      assertOk(run(['hydrate', '--target', target, '--adapter', adapter], target));
      assert.ok(existsSync(join(target, '.agenticloop', 'local', 'generated-artifacts.json')));
      assert.equal(git(target, ['status', '--porcelain']), '', `${adapter} hydration must leave Git clean`);
    }
  });

  it('merges allowed local model overrides only in memory and rejects unsafe fields', () => {
    const target = downstreamFixture();
    const configPath = join(target, 'agenticloop.json');
    const before = readFileSync(configPath);
    mkdirSync(join(target, '.agenticloop', 'local'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'local', 'config.json'), JSON.stringify({
      adapters: { opencode: { roleSettings: { engineer: { model: 'clone/model', reasoningEffort: 'high' } } } },
    }, null, 2));
    assertOk(run(['hydrate', '--target', target, '--adapter', 'opencode'], target));
    const agent = readFileSync(join(target, '.opencode', 'agents', 'engineer.md'), 'utf8');
    assert.match(agent, /model: "clone\/model"/);
    assert.match(agent, /variant: "high"/);
    assert.deepEqual(readFileSync(configPath), before);

    rmSync(join(target, '.opencode'), { recursive: true, force: true });
    rmSync(join(target, '.agenticloop', 'local', 'generated-artifacts.json'), { force: true });
    writeFileSync(join(target, '.agenticloop', 'local', 'config.json'), '{"outputDirectory":"../escape"}\n');
    const invalid = run(['hydrate', '--target', target, '--adapter', 'opencode'], target);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Invalid local configuration.*unknown field 'outputDirectory'/);
    assert.equal(existsSync(join(target, '.opencode')), false);
  });

  it('refuses non-ignored and user-owned destinations before writing', () => {
    const target = downstreamFixture();
    const ignorePath = join(target, '.gitignore');
    writeFileSync(ignorePath, readFileSync(ignorePath, 'utf8').replace('.opencode/\n', ''));
    git(target, ['add', '.gitignore']);
    git(target, ['-c', 'user.name=Agentic Loop Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'remove ignore']);
    const nonIgnored = run(['hydrate', '--target', target, '--adapter', 'opencode'], target);
    assert.equal(nonIgnored.status, 1);
    assert.match(nonIgnored.stderr, /not ignored/);
    assert.equal(existsSync(join(target, '.opencode')), false);

    writeFileSync(ignorePath, `${readFileSync(ignorePath, 'utf8')}.opencode/\n`);
    git(target, ['add', '.gitignore']);
    git(target, ['-c', 'user.name=Agentic Loop Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'restore ignore']);
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true });
    const collisionPath = join(target, '.opencode', 'agents', 'engineer.md');
    writeFileSync(collisionPath, 'user-owned\n');
    const collision = run(['hydrate', '--target', target, '--adapter', 'opencode'], target);
    assert.equal(collision.status, 1);
    assert.match(collision.stderr, /not owned by Agentic Loop/);
    assert.equal(readFileSync(collisionPath, 'utf8'), 'user-owned\n');
  });

  it('refuses hydration when Git cleanliness cannot be verified', () => {
    const target = downstreamFixture();
    rmSync(join(target, '.git'), { recursive: true, force: true });
    const result = run(['hydrate', '--target', target, '--adapter', 'opencode'], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to verify Git cleanliness for hydration/);
    assert.equal(existsSync(join(target, '.opencode')), false);
  });

  it('fails closed when the Git probe cannot run', () => {
    const target = downstreamFixture();
    const result = run(['hydrate', '--target', target, '--adapter', 'opencode'], target, {
      env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to verify Git cleanliness for hydration/);
    assert.equal(existsSync(join(target, '.opencode')), false);
  });

  it('fails closed when Git environment overrides hide a worktree', () => {
    const target = downstreamFixture();
    const result = run(['hydrate', '--target', target, '--adapter', 'opencode'], target, {
      env: { ...process.env, GIT_DIR: join(target, 'missing-git-dir') },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to verify Git cleanliness for hydration/);
    assert.equal(existsSync(join(target, '.opencode')), false);
  });

  it('fails closed when Git cannot inspect destination tracking', () => {
    const target = downstreamFixture();
    const invalidIndex = join(target, 'invalid.index');
    writeFileSync(invalidIndex, 'not a Git index\n');
    const result = run(['hydrate', '--target', target, '--adapter', 'opencode'], target, {
      env: { ...process.env, GIT_INDEX_FILE: invalidIndex },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to verify Git tracking for hydration destination/);
    assert.equal(existsSync(join(target, '.opencode')), false);
  });

  it('protects modified generated files, supports explicit force, and avoids timestamp churn', () => {
    const target = downstreamFixture();
    assertOk(run(['hydrate', '--target', target, '--adapter', 'opencode'], target));
    const manifestPath = join(target, '.agenticloop', 'local', 'generated-artifacts.json');
    const agentPath = join(target, '.opencode', 'agents', 'engineer.md');
    const manifestBefore = readFileSync(manifestPath);
    const agentMtime = statSync(agentPath).mtimeMs;
    assertOk(run(['hydrate', '--target', target, '--adapter', 'opencode'], target));
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
    assert.equal(statSync(agentPath).mtimeMs, agentMtime);

    writeFileSync(agentPath, 'locally modified\n');
    const blocked = run(['hydrate', '--target', target, '--adapter', 'opencode'], target);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /has been modified/);
    assertOk(run(['hydrate', '--target', target, '--adapter', 'opencode', '--force-generated'], target));
    assert.doesNotMatch(readFileSync(agentPath, 'utf8'), /locally modified/);
    assert.equal(git(target, ['status', '--porcelain']), '');
  });

  it('reports preserved modified stale artifacts after successful hydration', () => {
    const target = downstreamFixture();
    assertOk(run(['hydrate', '--target', target, '--adapter', 'opencode'], target));
    const manifestPath = join(target, '.agenticloop', 'local', 'generated-artifacts.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const generatedEntry = manifest.entries.find(entry =>
      entry.kind === 'file' && entry.relPath.startsWith('.opencode/agents/')
    );
    assert.ok(generatedEntry, 'fixture hydration must generate an OpenCode agent');

    const staleRelPath = '.opencode/agents/retired.md';
    const stalePath = join(target, ...staleRelPath.split('/'));
    const generatedContent = 'generated stale artifact\n';
    writeFileSync(stalePath, generatedContent);
    manifest.entries.push({
      ...generatedEntry,
      relPath: staleRelPath,
      hash: createHash('sha256').update(generatedContent).digest('hex'),
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(stalePath, 'locally modified stale artifact\n');

    const result = run(['hydrate', '--target', target, '--adapter', 'opencode'], target);
    assertOk(result);
    assert.match(result.stderr, /WARN: Preserved modified stale generated file: .opencode\/agents\/retired.md/);
    assert.equal(readFileSync(stalePath, 'utf8'), 'locally modified stale artifact\n');
  });

  it('rechecks Git output safety before the generation transaction mutates', () => {
    const target = downstreamFixture();
    const plan = planHydration({ target, adapter: 'opencode' });
    assert.deepEqual(plan.blockers, []);

    const ignorePath = join(target, '.gitignore');
    writeFileSync(ignorePath, readFileSync(ignorePath, 'utf8').replace('.opencode/\n', ''));
    const result = applyHydration({ target, adapter: 'opencode', plan });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Hydration destination '.opencode\/agents\/engineer.md' is not ignored/);
    assert.equal(existsSync(join(target, '.opencode')), false, 'the late Git check must run before generation writes');
  });

  it('refuses tracked stale artifacts selected for cleanup before deleting them', () => {
    const target = downstreamFixture();
    assertOk(run(['hydrate', '--target', target, '--adapter', 'opencode'], target));
    const manifestPath = join(target, '.agenticloop', 'local', 'generated-artifacts.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const generatedEntry = manifest.entries.find(entry =>
      entry.kind === 'file' && entry.relPath.startsWith('.opencode/agents/')
    );
    assert.ok(generatedEntry, 'fixture hydration must generate an OpenCode agent');

    const staleRelPath = '.opencode/agents/tracked-retired.md';
    const stalePath = join(target, ...staleRelPath.split('/'));
    const staleContent = 'generated stale artifact\n';
    writeFileSync(stalePath, staleContent);
    manifest.entries.push({
      ...generatedEntry,
      relPath: staleRelPath,
      hash: createHash('sha256').update(staleContent).digest('hex'),
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const plan = planHydration({ target, adapter: 'opencode' });
    assert.deepEqual(plan.blockers, []);

    git(target, ['add', '--force', staleRelPath]);
    git(target, ['-c', 'user.name=Agentic Loop Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'track stale artifact']);
    const result = applyHydration({ target, adapter: 'opencode', plan });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Hydration destination '.opencode\/agents\/tracked-retired.md' is tracked/);
    assert.equal(readFileSync(stalePath, 'utf8'), staleContent);
  });
});

describe('two-clone isolation regression', () => {
  it('keeps different local hosts clean across repository-only update and pull', () => {
    const seed = downstreamFixture({ staleCanonical: true });
    const cloneA = join(root, 'clone-a');
    const cloneB = join(root, 'clone-b');
    git(root, ['-c', 'core.autocrlf=false', 'clone', seed, cloneA]);
    git(root, ['-c', 'core.autocrlf=false', 'clone', seed, cloneB]);
    for (const [clone, host, model] of [[cloneA, 'opencode', 'clone-a/model'], [cloneB, 'codex', 'clone-b/model']]) {
      mkdirSync(join(clone, '.agenticloop', 'local'), { recursive: true });
      writeFileSync(join(clone, '.agenticloop', 'local', 'config.json'), JSON.stringify({
        adapters: { [host]: { roleSettings: { engineer: { model } } } },
      }, null, 2));
      assertOk(run(['hydrate', '--target', clone, '--adapter', host], clone));
      assert.equal(git(clone, ['status', '--porcelain']), '');
    }
    assert.equal(git(cloneA, ['rev-parse', 'HEAD^{tree}']), git(cloneB, ['rev-parse', 'HEAD^{tree}']));

    assertOk(run(['update', '--target', cloneA, '--repository-only', '--dry-run'], cloneA));
    assertOk(run(['update', '--target', cloneA, '--repository-only'], cloneA));
    git(cloneA, ['add', '.']);
    git(cloneA, ['-c', 'user.name=Agentic Loop Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'update toolkit']);
    git(cloneB, ['pull', '--ff-only', cloneA, 'main']);
    assertOk(run(['hydrate', '--target', cloneB, '--adapter', 'codex'], cloneB));
    assert.equal(git(cloneB, ['status', '--porcelain']), '');
    const secondUpdate = run(['update', '--target', cloneB, '--repository-only', '--dry-run', '--json'], cloneB);
    assertOk(secondUpdate);
    assertOk(run(['update', '--target', cloneB, '--repository-only'], cloneB));
    assert.equal(git(cloneB, ['status', '--porcelain']), '');
  });
});
