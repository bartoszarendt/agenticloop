/**
 * CLI lifecycle tests for update and remove.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-lifecycle-cli-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTarget() {
  return mkdtempSync(join(tmpDir, 'target-'));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    ...options,
  });
}

function assertOk(result) {
  assert.equal(
    result.status,
    0,
    `expected command to pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function assertSourceRepoUntouched() {
  for (const relPath of [
    'AGENTIC_LOOP.md',
    'agents',
    'backends',
    'skills',
    'commands',
    'memory',
    'config.json',
    'agenticloop.template.json',
    'manifest.json',
  ]) {
    assert.equal(existsSync(join(REPO_ROOT, relPath)), true, `${relPath} should remain at the package source root`);
  }
  assert.equal(existsSync(join(REPO_ROOT, 'agenticloop', 'manifest.json')), false, 'source repo should not gain an installed agenticloop/ payload');
}

describe('lifecycle CLI', () => {
  it('validate passes in the package source repo layout', () => {
    const result = run(['validate'], { cwd: REPO_ROOT });

    assertOk(result);
    assert.doesNotMatch(result.stdout, /Missing activation corpus/);
    assert.doesNotMatch(result.stdout, /No configuration found/);
  });

  it('warns but continues when validate receives an unknown option', () => {
    const result = run(['validate', '--unknown-option'], { cwd: REPO_ROOT });

    assertOk(result);
    assert.match(result.stderr, /WARN: validate ignoring unknown option\(s\): --unknown-option/);
  });

  it('init refuses to mutate the package source repo root', () => {
    const result = run(['init'], { cwd: REPO_ROOT });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Refusing to mutate the Agentic Loop package source repository/);
    assertSourceRepoUntouched();
  });

  it('update refuses to mutate the package source repo root', () => {
    const result = run(['update'], { cwd: REPO_ROOT });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Refusing to mutate the Agentic Loop package source repository/);
    assertSourceRepoUntouched();
  });

  it('remove --dry-run refuses to target the package source repo root', () => {
    const result = run(['remove', '--dry-run'], { cwd: REPO_ROOT });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Refusing to mutate the Agentic Loop package source repository/);
    assert.doesNotMatch(result.stdout, /would remove: (AGENTIC_LOOP\.md|agents|backends|skills|commands|memory|config\.json|agenticloop\.template\.json|manifest\.json)/);
    assertSourceRepoUntouched();
  });

  it('rejects the removed init refresh flag', () => {
    const d = makeTarget();
    const result = run(['init', '--target', d, '--update-assets']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has been removed/);
    assert.ok(!existsSync(join(d, 'agenticloop')), 'init should stop before scaffolding');
  });

  it('update refreshes toolkit-owned assets, preserves target-owned config, and regenerates existing adapters', () => {
    const d = makeTarget();
    assertOk(run(['init', '--target', d, '--adapter', 'opencode']));

    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    mkdirSync(join(d, '.agenticloop', 'summaries'), { recursive: true });
    mkdirSync(join(d, '.agenticloop', 'decisions'), { recursive: true });
    mkdirSync(join(d, '.agenticloop', 'logs'), { recursive: true });
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-001.md'), '# task\n', 'utf-8');
    writeFileSync(join(d, '.agenticloop', 'summaries', 'release.md'), '# summary\n', 'utf-8');
    writeFileSync(join(d, '.agenticloop', 'decisions', 'D-001.md'), '# decision\n', 'utf-8');
    writeFileSync(join(d, '.agenticloop', 'logs', 'T-001.jsonl'), '{}\n', 'utf-8');
    writeFileSync(join(d, '.agenticloop', 'tmp', 'note.txt'), 'scratch\n', 'utf-8');

    writeFileSync(join(d, 'agenticloop', 'AGENTIC_LOOP.md'), 'stale process doc\n', 'utf-8');
    writeFileSync(join(d, 'agenticloop', 'config.json'), '{"stale": true}\n', 'utf-8');
    writeFileSync(join(d, 'opencode.jsonc'), '{"stale": true}\n', 'utf-8');
    mkdirSync(join(d, 'agenticloop', 'skills', 'obsolete-skill'), { recursive: true });
    writeFileSync(
      join(d, 'agenticloop', 'skills', 'obsolete-skill', 'SKILL.md'),
      'obsolete invalid skill payload\n',
      'utf-8'
    );
    writeFileSync(join(d, 'agenticloop.json'), JSON.stringify({
      extends: './agenticloop/config.json',
      targetOwnedMarker: 'keep',
      taskBackend: 'files',
      documents: {
        process: 'agenticloop/AGENTIC_LOOP.md',
      },
      adapters: {
        opencode: {
          roleSettings: {},
        },
      },
    }, null, 2) + '\n', 'utf-8');

    assertOk(run(['update', '--target', d]));

    assert.notEqual(readFileSync(join(d, 'agenticloop', 'AGENTIC_LOOP.md'), 'utf-8'), 'stale process doc\n');
    assert.notEqual(readFileSync(join(d, 'agenticloop', 'config.json'), 'utf-8'), '{"stale": true}\n');
    assert.ok(
      !existsSync(join(d, 'agenticloop', 'skills', 'obsolete-skill')),
      'update should prune stale toolkit-owned source entries'
    );
    assert.ok(
      readFileSync(join(d, 'agenticloop.json'), 'utf-8').includes('"targetOwnedMarker": "keep"'),
      'target-owned agenticloop.json should be preserved'
    );
    assert.ok(
      readFileSync(join(d, 'opencode.jsonc'), 'utf-8').includes('"stale": true'),
      'existing opencode.jsonc should be ignored and preserved as user-owned OpenCode config'
    );
    assert.ok(
      existsSync(join(d, '.opencode', 'agents', 'orchestrator.md')),
      'update should regenerate the repo-local OpenCode agents'
    );
    assert.ok(
      existsSync(join(d, '.opencode', 'commands', 'agenticloop.md')),
      'update should regenerate the repo-local OpenCode command'
    );
    assert.ok(existsSync(join(d, '.agenticloop', 'tasks', 'T-001.md')));
    assert.ok(existsSync(join(d, '.agenticloop', 'summaries', 'release.md')));
    assert.ok(existsSync(join(d, '.agenticloop', 'decisions', 'D-001.md')));
    assert.ok(existsSync(join(d, '.agenticloop', 'logs', 'T-001.jsonl')));
    assert.ok(existsSync(join(d, '.agenticloop', 'tmp', 'note.txt')));
    assert.ok(!existsSync(join(d, '.codex')), 'plain update must not create Codex artifacts for an OpenCode-only target');
    assert.ok(!existsSync(join(d, 'plugins', 'agenticloop')), 'plain update must not create Codex plugin artifacts for an OpenCode-only target');
    assert.ok(!existsSync(join(d, '.claude')), 'plain update must not create Claude Code artifacts for an OpenCode-only target');
    assert.ok(!existsSync(join(d, '.claude-plugin')), 'plain update must not create Claude Code plugin artifacts for an OpenCode-only target');
  });

  it('update does not infer Codex from a stale generated skills directory alone', () => {
    const d = makeTarget();
    assertOk(run(['init', '--target', d, '--adapter', 'opencode']));

    mkdirSync(join(d, '.agents', 'skills', 'agenticloop-role-delegation'), { recursive: true });
    writeFileSync(join(d, '.agents', 'skills', 'agenticloop-role-delegation', 'STALE.md'), 'stale\n', 'utf-8');

    assertOk(run(['update', '--target', d]));

    assert.ok(existsSync(join(d, '.agents', 'skills', 'agenticloop-role-delegation')), 'stale skills directory should be left alone');
    assert.ok(!existsSync(join(d, '.codex')), 'plain update must not create Codex agents from a skills copy alone');
    assert.ok(!existsSync(join(d, 'plugins', 'agenticloop')), 'plain update must not create Codex plugin from a skills copy alone');
  });

  it('remove requires explicit confirmation', () => {
    const d = makeTarget();
    assertOk(run(['init', '--target', d]));

    const result = run(['remove', '--target', d]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to remove/);
    assert.ok(existsSync(join(d, 'agenticloop')), 'assets should remain without --yes');
  });

  it('remove dry-run reports assets without deleting them', () => {
    const d = makeTarget();
    assertOk(run(['init', '--target', d, '--adapter', 'all']));

    const result = run(['remove', '--target', d, '--dry-run']);

    assertOk(result);
    assert.match(result.stdout, /would remove: agenticloop/);
    assert.match(result.stdout, /would remove: agenticloop\.json/);
    assert.ok(existsSync(join(d, 'agenticloop')), 'dry-run should not delete assets');
    assert.ok(existsSync(join(d, '.agenticloop')), 'dry-run should not delete data');
  });

  it('remove --yes deletes Agentic Loop assets and config', () => {
    const d = makeTarget();
    assertOk(run(['init', '--target', d, '--adapter', 'all']));
    writeFileSync(join(d, 'opencode.jsonc'), '{"userOwned": true}\n', 'utf-8');
    mkdirSync(join(d, '.github', 'instructions'), { recursive: true });
    mkdirSync(join(d, '.github', 'prompts'), { recursive: true });
    mkdirSync(join(d, '.github', 'skills', 'project-owned'), { recursive: true });
    mkdirSync(join(d, '.github', 'agents'), { recursive: true });
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(d, '.cursor', 'rules'), { recursive: true });
    mkdirSync(join(d, '.cursor', 'commands'), { recursive: true });
    mkdirSync(join(d, '.cursor', 'skills', 'project-owned'), { recursive: true });
    mkdirSync(join(d, '.cursor', 'agents'), { recursive: true });
    writeFileSync(join(d, '.github', 'copilot-instructions.md'), '# User-owned Copilot instructions\n', 'utf-8');
    writeFileSync(join(d, '.github', 'instructions', 'project.instructions.md'), '# User-owned path instructions\n', 'utf-8');
    writeFileSync(join(d, '.github', 'prompts', 'project-owned.prompt.md'), '# User-owned prompt\n', 'utf-8');
    writeFileSync(join(d, '.github', 'skills', 'project-owned', 'SKILL.md'), '# User-owned skill\n', 'utf-8');
    writeFileSync(join(d, '.github', 'agents', 'project-owned.agent.md'), '# User-owned agent\n', 'utf-8');
    writeFileSync(join(d, '.github', 'workflows', 'custom.yml'), 'name: custom\n', 'utf-8');
    writeFileSync(join(d, '.cursor', 'rules', 'project.mdc'), '# User-owned rule\n', 'utf-8');
    writeFileSync(join(d, '.cursor', 'commands', 'project.md'), '# User-owned command\n', 'utf-8');
    writeFileSync(join(d, '.cursor', 'skills', 'project-owned', 'SKILL.md'), '# User-owned Cursor skill\n', 'utf-8');
    writeFileSync(join(d, '.cursor', 'agents', 'project-owned.md'), '# User-owned Cursor agent\n', 'utf-8');

    assert.ok(!existsSync(join(d, '.claude-plugin')), 'Mode B init should not create .claude-plugin');
    assert.ok(existsSync(join(d, '.agents', 'skills', 'agenticloop', 'SKILL.md')), 'Codex public skill should exist before removal');
    assert.ok(existsSync(join(d, '.github', 'skills', 'agenticloop', 'SKILL.md')), 'Copilot public skill should exist before removal');
    assert.ok(existsSync(join(d, '.cursor', 'skills', 'agenticloop', 'SKILL.md')), 'Cursor public skill should exist before removal');

    const result = run(['remove', '--target', d, '--yes']);

    assertOk(result);
    for (const rel of [
      'agenticloop',
      'agenticloop.json',
      '.opencode',
      '.codex',
      '.claude',
    ]) {
      assert.ok(!existsSync(join(d, rel)), `${rel} should be removed`);
    }
    assert.ok(existsSync(join(d, '.agenticloop')), '.agenticloop should be preserved by default');
    assert.ok(existsSync(join(d, 'opencode.jsonc')), 'user-owned opencode.jsonc should not be removed');
    assert.ok(!existsSync(join(d, '.agents', 'skills', 'agenticloop')), 'generated Codex public skill should be removed');
    assert.ok(!existsSync(join(d, '.github', 'agents', 'orchestrator.agent.md')), 'generated Copilot agent should be removed');
    assert.ok(!existsSync(join(d, '.github', 'skills', 'agenticloop')), 'generated Copilot public skill should be removed');
    assert.ok(!existsSync(join(d, '.github', 'prompts', 'agenticloop.prompt.md')), 'generated Copilot prompt should be removed');
    assert.ok(!existsSync(join(d, '.cursor', 'agents', 'orchestrator.md')), 'generated Cursor agent should be removed');
    assert.ok(!existsSync(join(d, '.cursor', 'skills', 'agenticloop')), 'generated Cursor public skill should be removed');
    assert.ok(existsSync(join(d, '.github', 'copilot-instructions.md')), 'user-owned .github/copilot-instructions.md should be preserved');
    assert.ok(existsSync(join(d, '.github', 'instructions', 'project.instructions.md')), 'user-owned .github/instructions should be preserved');
    assert.ok(existsSync(join(d, '.github', 'prompts', 'project-owned.prompt.md')), 'user-owned .github/prompts should be preserved');
    assert.ok(existsSync(join(d, '.github', 'skills', 'project-owned', 'SKILL.md')), 'user-owned .github/skills should be preserved');
    assert.ok(existsSync(join(d, '.github', 'agents', 'project-owned.agent.md')), 'user-owned .github/agents should be preserved');
    assert.ok(existsSync(join(d, '.github', 'workflows', 'custom.yml')), 'user-owned .github/workflows should be preserved');
    assert.ok(existsSync(join(d, '.cursor', 'rules', 'project.mdc')), 'user-owned .cursor/rules should be preserved');
    assert.ok(existsSync(join(d, '.cursor', 'commands', 'project.md')), 'user-owned .cursor/commands should be preserved');
    assert.ok(existsSync(join(d, '.cursor', 'skills', 'project-owned', 'SKILL.md')), 'user-owned .cursor/skills should be preserved');
    assert.ok(existsSync(join(d, '.cursor', 'agents', 'project-owned.md')), 'user-owned .cursor/agents should be preserved');
  });

  it('remove --yes preserves an unrecognized hand-authored Codex skill collision', () => {
    const d = makeTarget();
    mkdirSync(join(d, '.agents', 'skills', 'agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agents', 'skills', 'agenticloop', 'SKILL.md'), [
      '---',
      'name: agenticloop',
      'description: Project-owned skill that should not be removed by name alone.',
      '---',
      '',
      'Project-owned content.',
      '',
    ].join('\n'), 'utf-8');

    const result = run(['remove', '--target', d, '--yes']);

    assertOk(result);
    assert.ok(
      existsSync(join(d, '.agents', 'skills', 'agenticloop', 'SKILL.md')),
      'unrecognized project-owned skill should remain'
    );
  });

  it('remove --yes --include-state deletes target-owned .agenticloop state explicitly', () => {
    const d = makeTarget();
    assertOk(run(['init', '--target', d]));

    const result = run(['remove', '--target', d, '--yes', '--include-state']);

    assertOk(result);
    assert.equal(existsSync(join(d, '.agenticloop')), false);
  });
});
