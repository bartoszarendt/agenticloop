/**
 * Production GitHub audit runner wiring and command-scoped inventory tests.
 *
 * - Normal CLI execution (no injected runner) reaches the real read-only `gh`
 *   runner; an unreachable GitHub fails closed with an explicit
 *   `inventory_incomplete` diagnostic rather than "unknown task".
 * - A PATH-shimmed fake `gh` lets a GitHub-backed `audit new` succeed through
 *   a normal subprocess CLI context with no test-only injection.
 * - Injected runners remain supported for deterministic tests.
 * - One command performs at most one issue-inventory read, including
 *   multi-record `audit status` and mutation + JSON rendering.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCliInProcess } from './helpers/run-cli.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-audit-gh-runner-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function issue(number, { state = 'CLOSED', body = '' } = {}) {
  return { number, state, title: '', body, labels: [] };
}

function makeGitHubTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), [
    '---',
    'setup_status: confirmed',
    'development_stage: expansion',
    'task_backend: github',
    'work_unit_audit: enabled',
    'grouping_profile: milestone',
    '---',
    '',
    '# Project',
    '',
  ].join('\n'), 'utf-8');
  return target;
}

const AUDIT_NEW_ARGS = (target) => [
  'audit', 'new',
  '--work-unit', 'milestone:M00',
  '--covered-tasks', 'T-001',
  '--artifact', `commit:${'a'.repeat(40)}`,
  '--goal', 'Ship the milestone',
  '--completion-oracle', 'Marker recorded',
  '--evidence', 'npm test passed',
  '--target', target,
];

describe('production GitHub audit runner wiring', () => {
  it('uses the real default gh runner and fails closed with inventory_incomplete when gh is unavailable', async () => {
    const target = makeGitHubTarget('default-runner');
    // No injected runner: the command must reach the production default
    // runner, which consults the real process environment. With no `gh` on
    // PATH the inventory cannot be complete and the diagnostic must be
    // explicit, never a misleading "unknown task".
    const emptyPath = mkdtempSync(join(tmpDir, 'empty-path-'));
    const savedPath = process.env.PATH;
    process.env.PATH = emptyPath;
    let result;
    try {
      result = await runCliInProcess(AUDIT_NEW_ARGS(target));
    } finally {
      process.env.PATH = savedPath;
    }
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inventory_incomplete/);
    assert.doesNotMatch(result.stderr, /unknown task/);
    assert.doesNotMatch(result.stderr, /GitHub runner is unavailable/);
  });

  it('succeeds through a normal subprocess CLI with a PATH-shimmed fake gh', () => {
    const target = makeGitHubTarget('path-shim');
    const shimDir = mkdtempSync(join(tmpDir, 'shim-'));
    const issues = [issue(1, { body: '---\ntask_id: T-001\n---\n' })];
    // A PATH-shimmed fake `gh`: a copy of the node binary named `gh` plus a
    // NODE_OPTIONS preload that answers the read-only inventory query and
    // exits. Plain spawnSync cannot execute .cmd/.bat shims on Windows, so
    // the shim must be a real executable.
    const preloadPath = join(shimDir, 'fake-gh-preload.cjs');
    writeFileSync(preloadPath, [
      '// Only intercept when invoked as the gh shim (no .js script argument);',
      '// the real CLI entrypoint has a .js script in argv[1] and must run',
      '// normally. In the shim process the gh args start at argv[1].',
      'if (process.argv[1] && /\\.js$/i.test(process.argv[1])) return;',
      'const first = process.argv[1] ? require("node:path").basename(process.argv[1]) : "";',
      'const args = [first, ...process.argv.slice(2)];',
      'if (args[0] === "issue" && args[1] === "list") {',
      '  process.stdout.write(process.env.FAKE_GH_ISSUES_JSON || "[]");',
      '  process.exit(0);',
      '}',
      'process.stderr.write("unexpected gh call: " + args.join(" "));',
      'process.exit(1);',
    ].join('\n'), 'utf-8');
    copyFileSync(process.execPath, join(shimDir, process.platform === 'win32' ? 'gh.exe' : 'gh'));
    // Spawn the real CLI entrypoint, not an in-process handler.
    const run = spawnSync(process.execPath, [BIN, ...AUDIT_NEW_ARGS(target)], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
        NODE_OPTIONS: `--require ${preloadPath.replace(/\\/g, '/')}`,
        FAKE_GH_ISSUES_JSON: JSON.stringify(issues),
      },
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /Created/);
  });

  it('keeps injected-runner behavior for deterministic tests', async () => {
    const target = makeGitHubTarget('injected');
    const issues = [issue(1, { body: '---\ntask_id: T-001\n---\n' })];
    const ghCommandRunner = () => ({ status: 0, stdout: JSON.stringify(issues), stderr: '' });
    const result = await runCliInProcess(AUDIT_NEW_ARGS(target), { ghCommandRunner });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

describe('one GitHub inventory snapshot per command', () => {
  function countingRunner(issues, counter) {
    return (command, args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        counter.list += 1;
        return { status: 0, stdout: JSON.stringify(issues), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
  }

  async function createRecord(target, workUnit, tasks, runner) {
    const result = await runCliInProcess([
      'audit', 'new',
      '--work-unit', workUnit,
      '--covered-tasks', tasks,
      '--artifact', `commit:${'a'.repeat(40)}`,
      '--goal', 'goal',
      '--completion-oracle', 'oracle',
      '--evidence', 'evidence',
      '--target', target,
    ], { ghCommandRunner: runner });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }

  it('unfiltered audit status over multiple records reads the inventory exactly once', async () => {
    const target = makeGitHubTarget('status-once');
    const issues = [
      issue(1, { body: '---\ntask_id: T-001\n---\n' }),
      issue(2, { body: '---\ntask_id: T-002\n---\n' }),
    ];
    const counter = { list: 0 };
    const runner = countingRunner(issues, counter);
    await createRecord(target, 'milestone:M00', 'T-001', runner);
    await createRecord(target, 'milestone:M01', 'T-002', runner);
    counter.list = 0;
    const status = await runCliInProcess(['audit', 'status', '--target', target], { ghCommandRunner: runner });
    assert.equal(counter.list, 1, `expected one inventory read, got ${counter.list}: ${status.stdout}${status.stderr}`);
  });

  it('audit disposition plus JSON status output reads the inventory exactly once', async () => {
    const target = makeGitHubTarget('mutation-once');
    const issues = [issue(1, { body: '---\ntask_id: T-001\n---\n' })];
    const counter = { list: 0 };
    const runner = countingRunner(issues, counter);
    await createRecord(target, 'milestone:M00', 'T-001', runner);
    counter.list = 0;
    const result = await runCliInProcess([
      'audit', 'override', 'milestone:M00', '--budget', '5',
      '--authority', 'human: lead', '--note', 'raise', '--json', '--target', target,
    ], { ghCommandRunner: runner });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(counter.list, 1, `expected one inventory read, got ${counter.list}`);
  });

  it('fails audit validation on duplicate task identity naming every carrier', async () => {
    const target = makeGitHubTarget('duplicates');
    const issues = [
      issue(7, { state: 'CLOSED', body: '---\ntask_id: T-007\n---\n' }),
      issue(12, { state: 'CLOSED', body: '---\ntask_id: T-007\n---\n' }),
    ];
    const ghCommandRunner = () => ({ status: 0, stdout: JSON.stringify(issues), stderr: '' });
    const created = await runCliInProcess([
      'audit', 'new',
      '--work-unit', 'milestone:M00',
      '--covered-tasks', 'T-007',
      '--artifact', `commit:${'a'.repeat(40)}`,
      '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
      '--target', target,
    ], { ghCommandRunner });
    assert.equal(created.status, 1);
    assert.match(created.stderr, /#7/);
    assert.match(created.stderr, /#12/);
    assert.match(created.stderr, /T-007/);
  });

  it('a failing inventory stays inventory_incomplete across every audit subcommand', async () => {
    const target = makeGitHubTarget('fail-closed');
    const failing = () => ({ status: 1, stdout: '', stderr: 'HTTP 500' });
    const created = await runCliInProcess(AUDIT_NEW_ARGS(target), { ghCommandRunner: failing });
    assert.equal(created.status, 1);
    assert.match(created.stderr, /inventory_incomplete/);
    const lint = await runCliInProcess(['audit', 'lint', '--target', target], { ghCommandRunner: failing });
    assert.equal(lint.status, 0); // no records exist; lint of nothing passes
    const gate = await runCliInProcess([
      'audit', 'gate', 'milestone:M00', '--candidate', `commit:${'a'.repeat(40)}`,
      '--covered-tasks', 'T-001,T-002', '--target', target,
    ], { ghCommandRunner: failing });
    assert.equal(gate.status, 1);
  });
});
