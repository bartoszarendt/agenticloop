/**
 * Tests for src/init.js.
 *
 * Covers:
 *   - Non-overwrite of AGENTS.md, IMPLEMENTATION_PLAN.md, ARCHITECTURE*.md, README.md
 *   - Non-overwrite of existing toolkit-owned assets without refreshAssets
 *   - Overwrite of existing toolkit-owned assets with refreshAssets
 *   - Creates .agenticloop/tasks/, .agenticloop/decisions/,
 *     .agenticloop/logs/, .agenticloop/tmp/
 *   - Creates .agenticloop/project.md (target-owned; never overwritten)
 *   - Creates .agenticloop/decisions/ (empty directory for decision records)
 *   - Plain init does NOT create agenticloop.json
 *   - --adapter init creates agenticloop.json extending ./agenticloop/config.json
 *   - Appends .agenticloop/tmp/ to .gitignore without disturbing existing content
 *   - Creates .gitignore if it does not exist
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { init } from '../src/init.js';
import { loadJsonFile } from '../src/json.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { TOOLKIT_SOURCE_RELATIVE_PATHS, toPackageSourcePath } from '../src/layout.js';
import { exactPathMatch } from '../src/layout-migration.js';
import { isValidTaskId, loadProjectMap } from '../src/project-map.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-init-test-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function makeEmptyTarget() {
  const d = mkdtempSync(join(tmpBase, 'target-'));
  return d;
}

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const sourcePath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyTree(sourcePath, destPath);
    } else {
      copyFileSync(sourcePath, destPath);
    }
  }
}

function packageSourcePath(...parts) {
  return join(REPO_ROOT, ...parts);
}

function assertInstalledPayloadMatchesPackageSource(targetRoot) {
  for (const installedRelPath of TOOLKIT_SOURCE_RELATIVE_PATHS) {
    const sourcePath = packageSourcePath(toPackageSourcePath(installedRelPath));
    const targetPath = join(targetRoot, installedRelPath);
    assert.equal(
      exactPathMatch(targetPath, sourcePath),
      true,
      `expected ${installedRelPath} to match package source ${toPackageSourcePath(installedRelPath)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Protected docs must never be overwritten
// ---------------------------------------------------------------------------

describe('init - protected docs are never overwritten', () => {
  it('does not overwrite AGENTS.md', async () => {
    const d = makeEmptyTarget();
    const original = '# My AGENTS.md - keep this\n';
    writeFileSync(join(d, 'AGENTS.md'), original);
    await init({ target: d });
    const content = readFileSync(join(d, 'AGENTS.md'), 'utf-8');
    assert.equal(content, original);
  });

  it('does not overwrite README.md', async () => {
    const d = makeEmptyTarget();
    const original = '# My README - keep this\n';
    writeFileSync(join(d, 'README.md'), original);
    await init({ target: d });
    const content = readFileSync(join(d, 'README.md'), 'utf-8');
    assert.equal(content, original);
  });

  it('does not overwrite IMPLEMENTATION_PLAN.md', async () => {
    const d = makeEmptyTarget();
    const original = '# My plan - keep this\n';
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), original);
    await init({ target: d });
    const content = readFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), 'utf-8');
    assert.equal(content, original);
  });

  it('does not overwrite ARCHITECTURE_PLAN.md', async () => {
    const d = makeEmptyTarget();
    const original = '# My architecture - keep this\n';
    writeFileSync(join(d, 'ARCHITECTURE_PLAN.md'), original);
    await init({ target: d });
    const content = readFileSync(join(d, 'ARCHITECTURE_PLAN.md'), 'utf-8');
    assert.equal(content, original);
  });
});

// ---------------------------------------------------------------------------
// Toolkit-owned assets: skip by default, overwrite with refreshAssets
// ---------------------------------------------------------------------------

describe('init - toolkit-owned asset overwrite behavior', () => {
  it('skips existing agenticloop/AGENTIC_LOOP.md without refreshAssets', async () => {
    const d = makeEmptyTarget();
    mkdirSync(join(d, 'agenticloop'), { recursive: true });
    const original = '# My existing AGENTIC_LOOP.md\n';
    writeFileSync(join(d, 'agenticloop', 'AGENTIC_LOOP.md'), original);
    const { skipped } = await init({ target: d, refreshAssets: false });
    const content = readFileSync(join(d, 'agenticloop', 'AGENTIC_LOOP.md'), 'utf-8');
    assert.equal(content, original);
    assert.ok(skipped.includes('agenticloop/AGENTIC_LOOP.md'), `expected agenticloop/AGENTIC_LOOP.md in skipped, got: ${JSON.stringify(skipped)}`);
  });

  it('overwrites agenticloop/AGENTIC_LOOP.md with refreshAssets', async () => {
    const d = makeEmptyTarget();
    mkdirSync(join(d, 'agenticloop'), { recursive: true });
    const original = '# My existing AGENTIC_LOOP.md\n';
    writeFileSync(join(d, 'agenticloop', 'AGENTIC_LOOP.md'), original);
    await init({ target: d, refreshAssets: true });
    const content = readFileSync(join(d, 'agenticloop', 'AGENTIC_LOOP.md'), 'utf-8');
    assert.notEqual(content, original);
    assert.ok(content.includes('Agentic Loop'), 'overwritten file should contain toolkit content');
  });
});

// ---------------------------------------------------------------------------
// project.md: target-owned, created once, never overwritten
// ---------------------------------------------------------------------------

describe('init - .agenticloop/project.md handling', () => {
  it('creates .agenticloop/project.md when absent', async () => {
    const d = makeEmptyTarget();
    const { created } = await init({ target: d });
    assert.ok(
      created.includes('.agenticloop/project.md'),
      `expected .agenticloop/project.md in created, got: ${JSON.stringify(created)}`
    );
    assert.ok(existsSync(join(d, '.agenticloop', 'project.md')));
  });

  it('project.md contains task_backend: files', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    assert.ok(content.includes('task_backend: files'), 'project.md should set files as default backend');
  });

  it('project.md contains event_logging: disabled', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    assert.ok(content.includes('event_logging: disabled'), 'project.md should disable event logging by default');
  });

  it('project.md starts with setup_status: unconfirmed', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    assert.ok(content.includes('setup_status: unconfirmed'), 'project.md should start unconfirmed');
  });

  it('project.md includes the empty verification operating-facts section', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    assert.match(content, /## Verification Operating Facts/);
    assert.match(content, /No project-wide verification operating facts are currently recorded\./);
  });

  it('project.md includes the canonical empty Project Operating Facts section', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    assert.match(content, /## Project Operating Facts/);
    assert.match(content, /No project-wide operating facts are currently recorded\./);
  });

  it('leaves an existing target-owned project.md byte-for-byte unchanged during init and refresh', async () => {
    const d = makeEmptyTarget();
    // A pre-existing project map without the Project Operating Facts section.
    const original = '---\nsetup_status: confirmed\nsetup_confirmed_at: "2026-01-01"\nsetup_confirmed_by: "maintainer"\ntask_backend: files\n---\n# Existing map without the new section\n';
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'project.md'), original);

    await init({ target: d });
    assert.equal(readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8'), original);

    await init({ target: d, refreshAssets: true });
    assert.equal(readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8'), original);
  });

  it('generated project.md accepts the default T-001 task id shape', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const projectMap = loadProjectMap(d);

    assert.equal(projectMap.config.task_id_regex, '^T-\\d{3,}$');
    assert.equal(isValidTaskId('T-001', projectMap.config.task_id_regex), true);
    assert.equal(isValidTaskId('T001', projectMap.config.task_id_regex), false);
  });

  it('skips existing .agenticloop/project.md without refreshAssets', async () => {
    const d = makeEmptyTarget();
    const original = '---\nsetup_status: unconfirmed\nsetup_confirmed_at: ""\nsetup_confirmed_by: ""\ntask_backend: files\n---\n# custom\n';
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'project.md'), original);
    const { skipped } = await init({ target: d, refreshAssets: false });
    assert.ok(
      skipped.includes('.agenticloop/project.md'),
      `expected .agenticloop/project.md in skipped, got: ${JSON.stringify(skipped)}`
    );
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    assert.equal(content, original, 'target-owned project.md must not be overwritten');
  });

  it('does not overwrite existing .agenticloop/project.md with refreshAssets', async () => {
    const d = makeEmptyTarget();
    const original = '---\nsetup_status: unconfirmed\nsetup_confirmed_at: ""\nsetup_confirmed_by: ""\ntask_backend: files\n---\n# custom\n';
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'project.md'), original);
    const { skipped, created } = await init({ target: d, refreshAssets: true });
    assert.ok(
      skipped.includes('.agenticloop/project.md'),
      `expected .agenticloop/project.md in skipped, got: ${JSON.stringify(skipped)}`
    );
    assert.ok(
      !created.includes('.agenticloop/project.md'),
      '.agenticloop/project.md should not be in created'
    );
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    assert.equal(content, original, 'target-owned project.md must survive refreshAssets');
  });
});

// ---------------------------------------------------------------------------
// decision records: target-owned, created once, never overwritten
// ---------------------------------------------------------------------------

describe('init - .agenticloop/decisions handling', () => {
  it('creates .agenticloop/decisions/ when absent', async () => {
    const d = makeEmptyTarget();
    const { created } = await init({ target: d });
    assert.ok(
      created.includes('.agenticloop/decisions/'),
      `expected .agenticloop/decisions/ in created, got: ${JSON.stringify(created)}`
    );
    assert.ok(existsSync(join(d, '.agenticloop', 'decisions')));
  });

  it('does not create .agenticloop/decisions/index.md on fresh init', async () => {
    const d = makeEmptyTarget();
    const { created } = await init({ target: d });
    assert.ok(
      !created.includes('.agenticloop/decisions/index.md'),
      `fresh init must not create .agenticloop/decisions/index.md; created: ${JSON.stringify(created)}`
    );
    assert.ok(!existsSync(join(d, '.agenticloop', 'decisions', 'index.md')));
  });

  it('does not create .agenticloop/decisions/template.md on fresh init', async () => {
    const d = makeEmptyTarget();
    const { created } = await init({ target: d });
    assert.ok(
      !created.includes('.agenticloop/decisions/template.md'),
      `fresh init must not create .agenticloop/decisions/template.md; created: ${JSON.stringify(created)}`
    );
    assert.ok(!existsSync(join(d, '.agenticloop', 'decisions', 'template.md')));
  });

  it('preserves existing target-owned legacy .agenticloop/decisions/index.md during update', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    mkdirSync(join(d, '.agenticloop', 'decisions'), { recursive: true });
    const originalIndex = '# Legacy decision index\n';
    writeFileSync(join(d, '.agenticloop', 'decisions', 'index.md'), originalIndex);

    await init({ target: d, refreshAssets: true });

    assert.equal(readFileSync(join(d, '.agenticloop', 'decisions', 'index.md'), 'utf-8'), originalIndex);
  });

  it('preserves existing target-owned legacy .agenticloop/decisions/template.md during update', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    mkdirSync(join(d, '.agenticloop', 'decisions'), { recursive: true });
    const originalTemplate = '# Legacy decision template\n';
    writeFileSync(join(d, '.agenticloop', 'decisions', 'template.md'), originalTemplate);

    await init({ target: d, refreshAssets: true });

    assert.equal(readFileSync(join(d, '.agenticloop', 'decisions', 'template.md'), 'utf-8'), originalTemplate);
  });
});

// ---------------------------------------------------------------------------
// Plain init must NOT create agenticloop.json
// ---------------------------------------------------------------------------

describe('init - plain init does not create adapter JSON config', () => {
  it('does not create agenticloop.json on plain init', async () => {
    const d = makeEmptyTarget();
    const { created } = await init({ target: d });
    assert.ok(
      !created.includes('agenticloop.json'),
      `plain init must not create agenticloop.json; created: ${JSON.stringify(created)}`
    );
    assert.ok(!existsSync(join(d, 'agenticloop.json')), 'agenticloop.json must not exist after plain init');
  });

  it('creates agenticloop/config.json but not root agenticloop.base.json on plain init', async () => {
    const d = makeEmptyTarget();
    const { created } = await init({ target: d });
    assert.ok(
      created.includes('agenticloop/config.json'),
      `plain init should create agenticloop/config.json; created: ${JSON.stringify(created)}`
    );
    assert.ok(existsSync(join(d, 'agenticloop', 'config.json')), 'agenticloop/config.json must exist after plain init');
    assert.ok(!existsSync(join(d, 'agenticloop.base.json')), 'root agenticloop.base.json must not exist after plain init');
  });

  it('does not create agenticloop.json with refreshAssets on a plain-init target', async () => {
    const d = makeEmptyTarget();
    await init({ target: d }); // plain init
    await init({ target: d, refreshAssets: true }); // refreshAssets without --adapter
    assert.ok(!existsSync(join(d, 'agenticloop.json')), 'agenticloop.json must not appear after refreshAssets');
  });
});

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

describe('init - creates required directories', () => {
  it('creates .agenticloop/tasks/', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(existsSync(join(d, '.agenticloop', 'tasks')));
  });

  it('does not create .agenticloop/summaries/', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(!existsSync(join(d, '.agenticloop', 'summaries')));
  });

  it('creates .agenticloop/decisions/', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(existsSync(join(d, '.agenticloop', 'decisions')));
  });

  it('creates .agenticloop/logs/', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(existsSync(join(d, '.agenticloop', 'logs')));
  });

  it('does not create .agenticloop/logs/events/', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(!existsSync(join(d, '.agenticloop', 'logs', 'events')));
  });

  it('does not create .agenticloop/phase-summaries/', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(!existsSync(join(d, '.agenticloop', 'phase-summaries')));
  });

  it('does not create .agenticloop/improvements/ on fresh init', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(!existsSync(join(d, '.agenticloop', 'improvements')));
  });

  it('does not include an improvements/ directory in memory/scaffold/', () => {
    assert.ok(
      !existsSync(join(REPO_ROOT, 'memory', 'scaffold', 'improvements')),
      'memory/scaffold/ must not contain an improvements/ directory'
    );
  });

  it('creates .agenticloop/tmp/', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(existsSync(join(d, '.agenticloop', 'tmp')));
  });

  it('does not copy memory scaffold .gitkeep placeholders into target state', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    for (const relPath of [
      ['tasks', '.gitkeep'],
      ['logs', '.gitkeep'],
      ['tmp', '.gitkeep'],
    ]) {
      assert.ok(
        !existsSync(join(d, '.agenticloop', ...relPath)),
        `${join('.agenticloop', ...relPath)} should not be copied`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// .gitignore handling
// ---------------------------------------------------------------------------

describe('init - .gitignore handling', () => {
  it('creates .gitignore with .agenticloop/tmp/ when it does not exist', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const gi = readFileSync(join(d, '.gitignore'), 'utf-8');
    assert.ok(gi.includes('.agenticloop/tmp/'), 'created .gitignore should include .agenticloop/tmp/');
  });

  it('appends .agenticloop/tmp/ to existing .gitignore without disturbing content', async () => {
    const d = makeEmptyTarget();
    const original = '# existing rules\nnode_modules/\n';
    writeFileSync(join(d, '.gitignore'), original);
    await init({ target: d });
    const gi = readFileSync(join(d, '.gitignore'), 'utf-8');
    assert.ok(gi.includes('node_modules/'), 'existing content must be preserved');
    assert.ok(gi.includes('.agenticloop/tmp/'), '.agenticloop/tmp/ must be added');
  });

  it('does not duplicate .agenticloop/tmp/ when already present', async () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');
    await init({ target: d });
    const gi = readFileSync(join(d, '.gitignore'), 'utf-8');
    const matches = gi.split('\n').filter(l => l.trim() === '.agenticloop/tmp/');
    assert.equal(matches.length, 1, '.agenticloop/tmp/ should appear exactly once');
  });

  it('adds the new scratch ignore even when legacy tmp is already gitignored', async () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, '.gitignore'), 'tmp\n');
    await init({ target: d });
    const gi = readFileSync(join(d, '.gitignore'), 'utf-8');
    assert.ok(gi.includes('tmp\n'), 'legacy tmp ignore should remain');
    assert.ok(gi.includes('.agenticloop/tmp/'), 'new scratch ignore should be added');
  });

  it('gitignores the per-lane worktrees directory alongside the scratch dir', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const gi = readFileSync(join(d, '.gitignore'), 'utf-8');
    assert.ok(gi.includes('.agenticloop/tmp/'), 'scratch dir should be ignored');
    assert.ok(gi.includes('.agenticloop/worktrees/'), 'worktrees dir should be ignored');
  });

  it('appends the worktrees ignore when only the scratch dir is already present', async () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');
    await init({ target: d });
    const gi = readFileSync(join(d, '.gitignore'), 'utf-8');
    const tmpMatches = gi.split('\n').filter(l => l.trim() === '.agenticloop/tmp/');
    assert.equal(tmpMatches.length, 1, '.agenticloop/tmp/ should not be duplicated');
    assert.ok(gi.includes('.agenticloop/worktrees/'), 'worktrees dir should be added');
  });

  it('does not duplicate the worktrees ignore when already present', async () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/worktrees/\n');
    await init({ target: d });
    const gi = readFileSync(join(d, '.gitignore'), 'utf-8');
    const matches = gi.split('\n').filter(l => l.trim() === '.agenticloop/worktrees/');
    assert.equal(matches.length, 1, '.agenticloop/worktrees/ should appear exactly once');
  });
});

// ---------------------------------------------------------------------------
// Canonical asset directories are copied
// ---------------------------------------------------------------------------

describe('init - copies canonical assets', () => {
  it('creates agenticloop/agents/ in target', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(existsSync(join(d, 'agenticloop', 'agents')), 'agenticloop/agents/ should be created');
    assert.ok(existsSync(join(d, 'agenticloop', 'agents', 'orchestrator.md')), 'agenticloop/agents/orchestrator.md should exist');
  });

  it('creates agenticloop/skills/ in target', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(existsSync(join(d, 'agenticloop', 'skills')), 'agenticloop/skills/ should be created');
  });

  it('creates agenticloop/backends/ in target', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(existsSync(join(d, 'agenticloop', 'backends')), 'agenticloop/backends/ should be created');
  });

  it('agenticloop/skills/ includes setup-agenticloop', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(
      existsSync(join(d, 'agenticloop', 'skills', 'setup-agenticloop', 'SKILL.md')),
      'agenticloop/skills/setup-agenticloop/SKILL.md should be copied'
    );
  });

  it('creates agenticloop/commands/start.md and agenticloop/manifest.json', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(existsSync(join(d, 'agenticloop', 'commands', 'start.md')));
    assert.ok(existsSync(join(d, 'agenticloop', 'manifest.json')));
  });

  it('does not create legacy root canonical copies on plain init', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    for (const relPath of ['AGENTIC_LOOP.md', 'agents', 'backends', 'skills', 'commands', 'agenticloop.base.json']) {
      assert.equal(existsSync(join(d, relPath)), false, `${relPath} should not exist at the target root`);
    }
  });

  it('migrates exact legacy root canonical assets into agenticloop/', async () => {
    const d = makeEmptyTarget();
    copyFileSync(packageSourcePath('AGENTIC_LOOP.md'), join(d, 'AGENTIC_LOOP.md'));
    copyTree(packageSourcePath('agents'), join(d, 'agents'));
    copyTree(packageSourcePath('backends'), join(d, 'backends'));
    copyTree(packageSourcePath('skills'), join(d, 'skills'));
    copyTree(packageSourcePath('commands'), join(d, 'commands'));
    copyFileSync(packageSourcePath('config.json'), join(d, 'agenticloop.base.json'));

    const result = await init({ target: d });

    assert.ok(result.migrated.includes('AGENTIC_LOOP.md -> agenticloop/AGENTIC_LOOP.md'));
    assert.ok(result.migrated.includes('agents -> agenticloop/agents'));
    assert.ok(result.migrated.includes('backends -> agenticloop/backends'));
    assert.ok(result.migrated.includes('skills -> agenticloop/skills'));
    assert.ok(result.migrated.includes('commands -> agenticloop/commands'));
    assert.ok(result.migrated.includes('agenticloop.base.json -> agenticloop/config.json'));
    for (const relPath of ['AGENTIC_LOOP.md', 'agents', 'backends', 'skills', 'commands', 'agenticloop.base.json']) {
      assert.equal(existsSync(join(d, relPath)), false, `${relPath} should be removed from the root after migration`);
    }
  });

  it('preserves unowned legacy root collisions and warns instead of migrating them', async () => {
    const d = makeEmptyTarget();
    mkdirSync(join(d, 'agents'), { recursive: true });
    writeFileSync(join(d, 'agents', 'orchestrator.md'), '# project-owned legacy collision\n');

    const result = await init({ target: d });

    assert.equal(existsSync(join(d, 'agents', 'orchestrator.md')), true);
    assert.ok(result.warnings.some(w => w.includes("Preserving legacy root asset 'agents'")));
  });

  it('copies a byte-equivalent installed toolkit payload from root package source', async () => {
    const d = makeEmptyTarget();

    await init({ target: d });

    assertInstalledPayloadMatchesPackageSource(d);
  });
});

// ---------------------------------------------------------------------------
// Adapter generation during init: creates JSON
// ---------------------------------------------------------------------------

describe('init - adapter generation creates JSON', () => {
  it('creates agenticloop.json when --adapter is used', async () => {
    const d = makeEmptyTarget();
    const { created } = await init({ target: d, adapter: 'opencode' });
    assert.ok(
      created.includes('agenticloop.json'),
      `agenticloop.json should be created by --adapter; created: ${JSON.stringify(created)}`
    );
    assert.ok(existsSync(join(d, 'agenticloop.json')));
  });

  it('keeps agenticloop/config.json when --adapter is used', async () => {
    const d = makeEmptyTarget();
    const { created } = await init({ target: d, adapter: 'opencode' });
    assert.ok(
      created.includes('agenticloop/config.json'),
      `agenticloop/config.json should be created by init; created: ${JSON.stringify(created)}`
    );
    assert.ok(existsSync(join(d, 'agenticloop', 'config.json')));
  });

  it('agenticloop.json created by --adapter does not contain taskBackend', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'opencode' });
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'taskBackend'), false,
      `expected generated config to omit taskBackend, got: ${JSON.stringify(cfg)}`);
    assert.equal(cfg.extends, './agenticloop/config.json');
    assert.deepEqual(Object.keys(cfg.adapters ?? {}), ['opencode']);
  });

  it('skips existing agenticloop.json when --adapter is used again', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'opencode' });
    const original = readFileSync(join(d, 'agenticloop.json'), 'utf-8');
    const { skipped } = await init({ target: d, adapter: 'opencode' });
    assert.ok(skipped.includes('agenticloop.json'));
    const content = readFileSync(join(d, 'agenticloop.json'), 'utf-8');
    assert.equal(content, original, 'existing agenticloop.json must not be overwritten');
  });

  it('generates OpenCode markdown agents with --adapter opencode', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'opencode' });
    assert.ok(existsSync(join(d, '.opencode', 'agents', 'orchestrator.md')), 'OpenCode orchestrator agent should be generated');
    assert.ok(existsSync(join(d, '.opencode', 'agents', 'maintainer.md')), 'OpenCode maintainer agent should be generated');
    assert.ok(existsSync(join(d, '.opencode', 'agents', 'engineer.md')), 'OpenCode engineer agent should be generated');
    assert.ok(existsSync(join(d, '.opencode', 'commands', 'agenticloop.md')), 'OpenCode command should be generated');
    assert.ok(!existsSync(join(d, 'opencode.jsonc')), 'opencode.jsonc should not be generated');
    const [frontmatter] = parseFrontmatter(readFileSync(join(d, '.opencode', 'agents', 'orchestrator.md'), 'utf-8'));
    assert.equal(frontmatter?.mode, 'primary');
  });

  it('generates Codex artifacts with --adapter codex', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'codex' });
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.deepEqual(Object.keys(cfg.adapters ?? {}), ['codex']);
    assert.ok(existsSync(join(d, '.codex', 'agents', 'orchestrator.toml')), 'Codex orchestrator TOML should exist');
    assert.ok(existsSync(join(d, '.codex', 'agents', 'maintainer.toml')), 'Codex maintainer TOML should exist');
    assert.ok(existsSync(join(d, '.codex', 'agents', 'engineer.toml')), 'Codex engineer TOML should exist');
    assert.ok(existsSync(join(d, '.agents', 'skills', 'agenticloop', 'SKILL.md')), 'Codex public skill should exist');
    assert.ok(existsSync(join(d, '.agents', 'skills', 'agenticloop', 'agents', 'openai.yaml')), 'Codex openai metadata should exist');
    assert.ok(!existsSync(join(d, '.agents', 'skills', 'agenticloop-start', 'SKILL.md')), 'Legacy Codex start skill should not exist');
    assert.ok(!existsSync(join(d, '.codex-plugin', 'plugin.json')), 'Codex plugin manifest should not exist by default');
  });

  it('generates Claude Code artifacts with --adapter claude-code', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'claude-code' });
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.deepEqual(Object.keys(cfg.adapters ?? {}), ['claude-code']);
    assert.ok(existsSync(join(d, '.claude', 'agents', 'orchestrator.md')), 'Claude Code orchestrator agent should exist');
    assert.ok(existsSync(join(d, '.claude', 'agents', 'maintainer.md')), 'Claude Code maintainer agent should exist');
    assert.ok(existsSync(join(d, '.claude', 'agents', 'engineer.md')), 'Claude Code engineer agent should exist');
    assert.ok(existsSync(join(d, '.claude', 'settings.local.json')), 'Claude Code settings.local.json should exist');
    assert.ok(existsSync(join(d, '.claude', 'skills', 'agenticloop')), 'Claude Code skills dir should exist');
    assert.ok(readFileSync(join(d, '.gitignore'), 'utf-8').includes('.claude/settings.local.json'));
    assert.ok(!existsSync(join(d, '.claude-plugin')), 'repo-local Claude Code init should not create .claude-plugin');
  });

  it('generates Copilot artifacts with --adapter copilot', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'copilot' });
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.deepEqual(Object.keys(cfg.adapters ?? {}), ['copilot']);
    assert.ok(existsSync(join(d, '.github', 'agents', 'orchestrator.agent.md')), 'Copilot orchestrator agent should exist');
    assert.ok(existsSync(join(d, '.github', 'agents', 'maintainer.agent.md')), 'Copilot maintainer agent should exist');
    assert.ok(existsSync(join(d, '.github', 'agents', 'engineer.agent.md')), 'Copilot engineer agent should exist');
    assert.ok(existsSync(join(d, '.github', 'skills', 'agenticloop', 'SKILL.md')), 'Copilot public skill should exist');
    assert.ok(existsSync(join(d, '.github', 'prompts', 'agenticloop.prompt.md')), 'Copilot prompt should exist');
    assert.ok(!existsSync(join(d, '.github', 'copilot-instructions.md')), 'Copilot init must not generate .github/copilot-instructions.md');
  });

  it('generates Cursor artifacts with --adapter cursor', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'cursor' });
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.deepEqual(Object.keys(cfg.adapters ?? {}), ['cursor']);
    assert.ok(existsSync(join(d, '.cursor', 'agents', 'orchestrator.md')), 'Cursor orchestrator agent should exist');
    assert.ok(existsSync(join(d, '.cursor', 'agents', 'maintainer.md')), 'Cursor maintainer agent should exist');
    assert.ok(existsSync(join(d, '.cursor', 'agents', 'engineer.md')), 'Cursor engineer agent should exist');
    assert.ok(existsSync(join(d, '.cursor', 'skills', 'agenticloop', 'SKILL.md')), 'Cursor public skill should exist');
    assert.ok(!existsSync(join(d, '.cursor', 'rules')), 'Cursor init must not generate .cursor/rules');
    assert.ok(!existsSync(join(d, '.cursor-plugin')), 'Cursor init must not generate a root .cursor-plugin');
  });

  it('generates all implemented adapter artifacts with --adapter all', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'all' });
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.deepEqual(Object.keys(cfg.adapters ?? {}), ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']);
    assert.ok(existsSync(join(d, '.opencode', 'agents', 'orchestrator.md')), 'OpenCode orchestrator agent should be generated');
    assert.ok(existsSync(join(d, '.opencode', 'commands', 'agenticloop.md')), 'OpenCode command should be generated');
    assert.ok(!existsSync(join(d, 'opencode.jsonc')), 'opencode.jsonc should not be generated');
    assert.ok(existsSync(join(d, '.codex', 'agents')), 'Codex agents dir should exist');
    assert.ok(existsSync(join(d, '.claude', 'agents')), 'Claude Code agents dir should exist');
    assert.ok(existsSync(join(d, '.claude', 'settings.local.json')), 'Claude Code settings.local.json should exist');
    assert.ok(existsSync(join(d, '.github', 'agents', 'orchestrator.agent.md')), 'Copilot agents should exist');
    assert.ok(existsSync(join(d, '.github', 'prompts', 'agenticloop.prompt.md')), 'Copilot prompt should exist');
    assert.ok(existsSync(join(d, '.cursor', 'agents', 'orchestrator.md')), 'Cursor agents should exist');
    assert.ok(existsSync(join(d, '.cursor', 'skills', 'agenticloop', 'SKILL.md')), 'Cursor public skill should exist');
    assert.ok(!existsSync(join(d, '.cursor', 'rules')), 'Cursor all init must not generate .cursor/rules');
    assert.ok(!existsSync(join(d, '.github', 'copilot-instructions.md')), 'Copilot all init must not generate .github/copilot-instructions.md');
    assert.ok(!existsSync(join(d, '.claude-plugin')), 'repo-local Claude Code init should not create .claude-plugin');
    assert.ok(!existsSync(join(d, '.cursor-plugin')), 'repo-local Cursor init should not create .cursor-plugin');
  });

  it('preserves --opencode as a compatibility alias for --adapter opencode', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, opencode: true });
    assert.ok(existsSync(join(d, '.opencode', 'agents', 'orchestrator.md')), 'OpenCode agents should be generated via --opencode alias');
    assert.ok(!existsSync(join(d, 'opencode.jsonc')), 'opencode.jsonc should not be generated via --opencode alias');
    assert.ok(existsSync(join(d, '.opencode', 'commands', 'agenticloop.md')), 'OpenCode command should be generated via --opencode alias');
  });
});

// ---------------------------------------------------------------------------
// refreshAssets refreshes agenticloop/config.json when it exists
// ---------------------------------------------------------------------------

describe('init - refreshAssets behavior with existing config.json', () => {
  it('refreshes agenticloop/config.json with refreshAssets when it exists', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'opencode' });
    const original = readFileSync(join(d, 'agenticloop', 'config.json'), 'utf-8');
    writeFileSync(join(d, 'agenticloop', 'config.json'), '{"stale": true}\n');
    await init({ target: d, refreshAssets: true });
    const content = readFileSync(join(d, 'agenticloop', 'config.json'), 'utf-8');
    assert.equal(content, original, 'toolkit-owned config should be refreshed by refreshAssets');
  });
});

// ---------------------------------------------------------------------------
// Field-finding fixes: breadcrumbs, banners, path convention
// ---------------------------------------------------------------------------

describe('init - .agenticloop/README.md breadcrumb', () => {
  it('creates .agenticloop/README.md on fresh init', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const readmePath = join(d, '.agenticloop', 'README.md');
    assert.ok(existsSync(readmePath), '.agenticloop/README.md should exist');
    const content = readFileSync(readmePath, 'utf-8');
    assert.ok(content.includes('Target-Owned Workflow State'), 'breadcrumb should identify target state');
    assert.ok(content.includes('.agenticloop/agents/'), 'breadcrumb should list invalid paths');
    assert.ok(content.includes('agenticloop/agents/'), 'breadcrumb should point to canonical paths');
  });

  it('does not overwrite target-edited .agenticloop/README.md', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    const readmePath = join(d, '.agenticloop', 'README.md');
    const custom = '# My custom state README\n';
    writeFileSync(readmePath, custom);
    await init({ target: d });
    const content = readFileSync(readmePath, 'utf-8');
    assert.equal(content, custom, 'target-owned README should not be overwritten');
  });
});

describe('init - no separate summaries store', () => {
  it('does not create a .agenticloop/summaries/ directory on fresh init', async () => {
    const d = makeEmptyTarget();
    await init({ target: d });
    assert.ok(
      !existsSync(join(d, '.agenticloop', 'summaries')),
      'task summaries are inline; no separate summaries directory should be created'
    );
  });
});

describe('init - OpenCode generated banners', () => {
  it('generated OpenCode agents include a generated-file banner', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'opencode' });
    const agentPath = join(d, '.opencode', 'agents', 'orchestrator.md');
    assert.ok(existsSync(agentPath), 'OpenCode orchestrator agent should exist');
    const content = readFileSync(agentPath, 'utf-8');
    assert.ok(content.includes('Generated by Agentic Loop'), 'agent should contain generated banner');
    assert.ok(content.includes('agenticloop.json'), 'banner should reference agenticloop.json');
  });

  it('generated OpenCode command includes a generated-file banner', async () => {
    const d = makeEmptyTarget();
    await init({ target: d, adapter: 'opencode' });
    const cmdPath = join(d, '.opencode', 'commands', 'agenticloop.md');
    assert.ok(existsSync(cmdPath), 'OpenCode command should exist');
    const content = readFileSync(cmdPath, 'utf-8');
    assert.ok(content.includes('Generated by Agentic Loop'), 'command should contain generated banner');
  });
});
