import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { initTestGitRepository } from './helpers/git-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { createDispatchFixture, prepare as prepareDispatch, git as fixtureGit, repositoryEvidence, readyReturn } from './helpers/dispatch-fixture.js';
import { createAuthenticatedReturnReceipts, protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { canonicalSha256 } from '../src/canonical-json.js';
import { createCancellationProvenance } from '../src/cancellation-provenance.js';
import { createRoleReturn, dispatchPreparationDigest } from '../src/dispatch-envelope.js';
import { createExecutionReceiptReplayAuthority } from '../src/host-trust.js';
import { listReturnVerifications, revalidateReturnVerification, writeReturnVerification } from '../src/return-verification.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';

let tmpDir;
const IS_WINDOWS = platform() === 'win32';

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-task-cli-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Run the `task` command in-process (no subprocess, no full init). Behavior,
// output, and exit codes match the real binary; the small subprocess smoke
// surface for the binary lives in test/cli-smoke.test.js.
function run(args) {
  return runCliInProcess([...args]);
}

// Real callers read the current digest before mutating and supply explicit
// base and dependency evidence. These helpers only compute those values; every
// call site below passes them as visible arguments, so a command that stops
// requiring them fails observably here.
function currentDigest(target, taskId) {
  const content = readFileSync(taskPath(target, taskId), 'utf8');
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function baseTree(target) {
  return git(target, ['rev-parse', 'HEAD^{tree}']);
}

function dependencySnapshot(target, statuses = {}) {
  const relPath = 'dependency-evidence/dependencies.json';
  mkdirSync(join(target, 'dependency-evidence'), { recursive: true });
  writeFileSync(join(target, relPath), `${JSON.stringify({
    kind: 'agenticloop.dependency-snapshot',
    schemaVersion: 1,
    source: 'files:.agenticloop/tasks',
    observedAt: new Date().toISOString(),
    freshnessPolicy: { maxAgeSeconds: 86400 },
    statuses,
  })}
`, 'utf8');
  git(target, ['add', relPath]);
  git(target, ['commit', '-m', 'record dependency evidence\n\nTask: T-001\nAgent: maintainer']);
  return relPath;
}

function assertOk(result) {
  assert.equal(result.status, 0, `expected pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// This is deliberately test-owned rather than a role-return constructor: the
// GitHub producer has no public prepare-return command. It models the external
// role wire after public commands created every available ordinary input.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function externalRoleReturn(fields) {
  const value = {
    kind: 'agenticloop.role-return',
    schemaVersion: 4,
    requiredCheckEvidenceContract: 2,
    ...fields,
  };
  value.digest = `sha256:agenticloop.role-return.v4:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
  return value;
}

// Minimal per-test fixture in place of a full `agenticloop init`.
function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  createTaskProjectFixture(target);
  return target;
}

function taskPath(target, taskId) {
  return join(target, '.agenticloop', 'tasks', `${taskId}.md`);
}

async function establishBaseline(target, taskId = 'T-001') {
  git(target, ['add', '.agenticloop/tasks']);
  git(target, ['commit', '-m', `task ${taskId}`]);
  assertOk(await run(['task', 'establish-baseline', taskId, '--actor', 'Agentic Loop Test', '--authority', `task:${taskId}`, '--target', target]));
  git(target, ['add', '.agenticloop/task-contract-history']);
  git(target, ['commit', '-m', `baseline ${taskId}`]);
}

function verificationHistory(classification, reference) {
  return `## Verification Attempts

### RC-1

#### Attempt 1

- Artifact: commit:abc123
- Command: \`npm test\`
- Strategy: foreground
- Timeout ms: 180000
- Outcome: timed_out
- Duration ms: 180000
- Required: true
- Partial evidence: test process exceeded the foreground host ceiling
- Proposed next strategy: background
- Candidate classification: ${classification}
- Recorded by: engineer
- Recorded at: 2026-07-17T12:00:00Z

#### Triage for attempt 1

- Classification: ${classification}
- Reference: ${reference}
- Triaged by: maintainer
- Triaged at: 2026-07-17T12:30:00Z`;
}

function needsRevisionHistory(rounds, artifact = 'commit:abc123') {
  const entries = ['## Review History', ''];
  for (let round = 1; round <= rounds; round += 1) {
    entries.push(
      `### Review ${round}`,
      '- Status: needs_revision',
      '- Mode: host_subagent',
      `- Artifact: ${artifact}`,
      '- Findings: F-1',
      '- Maintainer: maintainer',
      ''
    );
  }
  return entries.join('\n');
}

const PROJECT_FACT = `### VF-full-suite

- Command: \`npm test\`
- Last outcome: timed_out
- Observed duration ms: 180000
- Timeout ms: 180000
- Host timeout ceiling ms: 180000
- Strategy: background
- Updated: 2026-07-17
- Source: T-001
- Revisit when: the suite layout, expected runtime, CI behavior, or host ceiling changes
- Decision: none`;

function writeAcceptedTask(target, taskId, { reviewStatus = 'needs_revision', extraFrontmatter = '' } = {}) {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(taskPath(target, taskId), `---
task_id: ${taskId}
status: accepted
backend: files
implementation_artifact: commit:abc123
review_status: ${reviewStatus}
reviewed_artifact: commit:abc123
review_mode: single_agent_fallback
${extraFrontmatter}---

# ${taskId} - Accepted

## Task
Ship the accepted behavior.

## Source Documents Reviewed
- README.md

## Current State
The task is complete.

## Scope
Document the accepted behavior.

## Out of Scope
No extra changes.

## Acceptance Criteria
- Accepted.

## Required Checks
- npm test

## Expected Files or Areas
- src/

## Implementation Notes
Implemented.

## Completion Summary Template
Use the summary below.

## Reviewer Checklist
- [x] Reviewed.

## Scope Completed
Implemented the scoped task.

## Artifacts
- commit:abc123

## Evidence
- npm test passed.

## Deviations
- none

## Process Observations
- none

## Known Gaps
- none

## Follow-Ups
- none

## Outcome

## Comments

## Revision Log
2026-07-07: Revision was requested before acceptance.
`, 'utf-8');
}

describe('task CLI', () => {
  it('creates, lists, lints, and refuses an unprepared role start', async () => {
    const target = makeTarget('happy');

    const created = await run(['task', 'new', 'Add CLI support', '--scaffold', '--target', target]);
    assertOk(created);
    assert.match(created.stdout, /Created \.agenticloop\/tasks\/T-001\.md/);
    assert.ok(existsSync(taskPath(target, 'T-001')));
    assert.match(readFileSync(taskPath(target, 'T-001'), 'utf-8'), /^attempt_budget: 5$/m);
    assert.match(readFileSync(taskPath(target, 'T-001'), 'utf-8'), /^review_budget: 5$/m);

    const list = await run(['task', 'list', '--target', target]);
    assertOk(list);
    assert.match(list.stdout, /T-001/);
    assert.match(list.stdout, /draft/);

    const lint = await run(['task', 'lint', 'T-001', '--target', target]);
    assertOk(lint);
    assert.match(lint.stdout, /T-001\.md: ok/);

    await establishBaseline(target);
    const status = await run(['task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentDigest(target, 'T-001'), '--base', baseTree(target), '--dependencies', dependencySnapshot(target), '--target', target]);
    assertOk(status);
    const status2 = await run(['task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(target, 'T-001'), '--note', 'Started implementation', '--target', target]);
    assert.notEqual(status2.status, 0);
    assert.match(status2.stderr, /canonical prepared dispatch/);
    const content = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    assert.match(content, /^status: agent-ready$/m);
    assert.doesNotMatch(content, /Started implementation/);
    assert.match(content, /## Verification Attempts\n\nNo verification attempts are currently recorded\./);
  });

  it('does not opt a serial task template into artifact-bound ownership', async () => {
    const target = makeTarget('serial-template');
    assertOk(await run(['task', 'new', 'Serial task', '--scaffold', '--target', target]));
    const path = taskPath(target, 'T-001');
    const content = readFileSync(path, 'utf-8')
      .replace('implementation_artifact:', 'implementation_artifact: branch:serial-task');
    writeFileSync(path, content, 'utf-8');

    const lint = await run(['task', 'lint', 'T-001', '--target', target]);
    assertOk(lint);
    assert.doesNotMatch(lint.stdout, /exact 'range:|undeclared path/);
  });

  it('materializes the configured project review budget without rewriting existing tasks', async () => {
    const target = makeTarget('project-review-budget');
    const projectPath = join(target, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf-8').replace('default_review_budget: 5', 'default_review_budget: 7'),
      'utf-8'
    );
    assertOk(await run(['task', 'new', 'Policy task', '--scaffold', '--target', target]));
    assert.match(readFileSync(taskPath(target, 'T-001'), 'utf-8'), /^review_budget: 7$/m);

    writeFileSync(projectPath, readFileSync(projectPath, 'utf-8').replace('default_review_budget: 7', 'default_review_budget: 2'), 'utf-8');
    assert.match(readFileSync(taskPath(target, 'T-001'), 'utf-8'), /^review_budget: 7$/m);
  });

  it('materializes the configured project attempt budget without rewriting existing tasks', async () => {
    const target = makeTarget('project-attempt-budget');
    const projectPath = join(target, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf-8').replace('default_attempt_budget: 5', 'default_attempt_budget: 8'),
      'utf-8'
    );
    assertOk(await run(['task', 'new', 'Attempt policy task', '--scaffold', '--target', target]));
    assert.match(readFileSync(taskPath(target, 'T-001'), 'utf-8'), /^attempt_budget: 8$/m);

    const taskFile = taskPath(target, 'T-001');
    writeFileSync(taskFile, readFileSync(taskFile, 'utf-8').replace(/^attempt_budget: 8$/m, 'attempt_budget: 3'), 'utf-8');
    writeFileSync(projectPath, readFileSync(projectPath, 'utf-8').replace('default_attempt_budget: 8', 'default_attempt_budget: 2'), 'utf-8');
    assert.match(readFileSync(taskFile, 'utf-8'), /^attempt_budget: 3$/m);
    assertOk(await run(['task', 'lint', 'T-001', '--target', target]));
  });

  it('accepts legacy missing attempt budgets and rejects invalid or duplicate stored values', async () => {
    const target = makeTarget('attempt-budget-validation');
    const projectPath = join(target, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf-8').replace('default_attempt_budget: 5', 'default_attempt_budget: 2'),
      'utf-8'
    );
    assertOk(await run(['task', 'new', 'Legacy attempt policy task', '--scaffold', '--target', target]));
    const path = taskPath(target, 'T-001');

    const legacy = readFileSync(path, 'utf-8').replace(/^attempt_budget: 2\r?\n/m, '');
    writeFileSync(path, legacy, 'utf-8');
    assertOk(await run(['task', 'lint', 'T-001', '--target', target]));
    assert.doesNotMatch(readFileSync(path, 'utf-8'), /^attempt_budget:/m);

    writeFileSync(projectPath, readFileSync(projectPath, 'utf-8').replace('default_attempt_budget: 2', 'default_attempt_budget: 0'), 'utf-8');
    const invalidProjectFallback = await run(['task', 'lint', 'T-001', '--target', target]);
    assert.notEqual(invalidProjectFallback.status, 0);
    assert.match(invalidProjectFallback.stdout, /default_attempt_budget must be a positive safe integer/);
    writeFileSync(projectPath, readFileSync(projectPath, 'utf-8').replace('default_attempt_budget: 0', 'default_attempt_budget: 2'), 'utf-8');

    writeFileSync(path, legacy.replace(/^review_budget:/m, 'attempt_budget: 0\nreview_budget:'), 'utf-8');
    const invalid = await run(['task', 'lint', 'T-001', '--target', target]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout, /attempt_budget '0' must be a positive integer/);

    writeFileSync(path, legacy.replace(/^review_budget:/m, 'attempt_budget: 2\nattempt_budget: 3\nreview_budget:'), 'utf-8');
    const duplicate = await run(['task', 'lint', 'T-001', '--target', target]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stdout, /attempt_budget appears more than once in frontmatter/);
  });

  it('rejects an explicitly empty project attempt budget during task creation', async () => {
    const target = makeTarget('empty-attempt-project-policy');
    const projectPath = join(target, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf-8').replace('default_attempt_budget: 5', 'default_attempt_budget: ""'),
      'utf-8'
    );

    const result = await run(['task', 'new', 'Invalid policy task', '--scaffold', '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /default_attempt_budget must be a positive safe integer/);
    assert.equal(existsSync(taskPath(target, 'T-001')), false);
  });

  it('uses the project review budget when authorizing a legacy task revision', async () => {
    const target = makeTarget('legacy-project-review-budget');
    const projectPath = join(target, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf-8').replace('default_review_budget: 5', 'default_review_budget: 2'),
      'utf-8'
    );
    assertOk(await run(['task', 'new', 'Legacy policy task', '--scaffold', '--target', target]));

    const path = taskPath(target, 'T-001');
    let content = readFileSync(path, 'utf-8')
      .replace(/^status: draft$/m, 'status: needs_revision')
      .replace(/^review_budget: 2\r?\n/m, '')
      .replace(/^implementation_artifact:$/m, 'implementation_artifact: commit:abc123')
      .replace(/^review_status:$/m, 'review_status: needs_revision');
    content = `${content.trimEnd()}\n\n${needsRevisionHistory(2)}\n`;
    writeFileSync(path, content, 'utf-8');

    const result = await run(['task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checkpoint.*required|budget.*exhausted/i);
    assert.match(readFileSync(path, 'utf-8'), /^status: needs_revision$/m);
  });

  it('enforces artifact-bound ownership during task lint', async () => {
    const target = makeTarget('ownership-artifact');
    assertOk(await run(['task', 'new', 'Owned artifact', '--scaffold', '--target', target]));
    const path = taskPath(target, 'T-001');
    let content = readFileSync(path, 'utf-8')
      .replace('allowed_paths: []', 'allowed_paths:\n  - src/**')
      .replace('# owned_paths:\n#   - src/example.js', 'owned_paths:\n  - src/expected.js');
    writeFileSync(path, content, 'utf-8');

    initTestGitRepository(target, {
      initialBranch: 'main',
      quiet: true,
      userName: 'Agentic Loop Test',
      userEmail: 'agenticloop@example.invalid',
    });
    git(target, ['add', '.']);
    git(target, ['commit', '-q', '-m', 'base']);
    const base = git(target, ['rev-parse', 'HEAD']);

    mkdirSync(join(target, 'src'), { recursive: true });
    writeFileSync(join(target, 'src', 'actual.js'), 'export const actual = true;\n', 'utf-8');
    git(target, ['add', 'src/actual.js']);
    git(target, ['commit', '-q', '-m', 'unexpected write']);
    const head = git(target, ['rev-parse', 'HEAD']);
    content = readFileSync(path, 'utf-8')
      .replace('implementation_artifact:', `implementation_artifact: range:${base}..${head}`);
    writeFileSync(path, content, 'utf-8');

    const lint = await run(['task', 'lint', 'T-001', '--target', target]);
    assert.notEqual(lint.status, 0);
    assert.match(lint.stdout, /artifact changed undeclared path 'src\/actual\.js'/);
  });

  it('appends notes to the live Comments section, not a fenced example', async () => {
    const target = makeTarget('comments-fence');
    writeAcceptedTask(target, 'T-001', { reviewStatus: 'accepted' });
    const path = taskPath(target, 'T-001');
    const original = readFileSync(path, 'utf-8').replace(/^status: accepted$/m, 'status: in-progress').replace(
      '## Outcome\n',
      '## Outcome\n\n```md\n## Comments\nexample only\n```\n'
    );
    writeFileSync(path, original, 'utf-8');

    const result = await run(['task', 'status', 'T-001', 'blocked', '--block-category', 'dependency', '--expect-digest', currentDigest(target, 'T-001'), '--note', 'Live note', '--target', target]);
    assertOk(result);
    const content = readFileSync(path, 'utf-8');
    assert.match(content, /```md\n## Comments\nexample only\n```/);
    assert.match(content, /## Comments\n- \d{4}-\d{2}-\d{2}: Live note/);
  });

  it('allocates the next default id after gaps', async () => {
    const target = makeTarget('gaps');
    assertOk(await run(['task', 'new', 'First', '--scaffold', '--id', 'T-001', '--target', target]));
    assertOk(await run(['task', 'new', 'Third', '--scaffold', '--id', 'T-003', '--target', target]));

    const result = await run(['task', 'new', 'Fourth', '--scaffold', '--target', target, '--json']);
    assertOk(result);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.task_id, 'T-004');
    assert.ok(existsSync(taskPath(target, 'T-004')));
  });

  it('refuses to overwrite an existing task file', async () => {
    const target = makeTarget('overwrite');
    assertOk(await run(['task', 'new', 'Original', '--scaffold', '--target', target]));

    const result = await run(['task', 'new', 'Duplicate', '--scaffold', '--id', 'T-001', '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
  });

  it('refuses files task operations when the active backend is github', async () => {
    const target = makeTarget('github-guard');
    const projectPath = join(target, '.agenticloop', 'project.md');
    const content = readFileSync(projectPath, 'utf-8').replace('task_backend: files', 'task_backend: github');
    writeFileSync(projectPath, content, 'utf-8');

    const result = await run(['task', 'list', '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /supports the files backend only/);
  });

  it('warns and refuses when the active backend is unsupported', async () => {
    const target = makeTarget('invalid-backend');
    const projectPath = join(target, '.agenticloop', 'project.md');
    const content = readFileSync(projectPath, 'utf-8').replace('task_backend: files', 'task_backend: jira');
    writeFileSync(projectPath, content, 'utf-8');

    const result = await run(['task', 'list', '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported task backend 'jira'/);
    assert.match(result.stderr, /Configured task backend 'jira' from project\.md is not supported/);
  });

  /**
   * Backend resolution is centralized ahead of subcommand routing, so every
   * `task` subcommand must answer an unusable or incompatible backend the same
   * way. Before that, only `prepare-decomposition` and `prepare-dispatch`
   * validated the configured value; the rest fell through a files-only guard
   * that wrote untyped stderr text and ignored `--json`, so the same
   * misconfiguration produced two different diagnostics depending on which
   * subcommand happened to observe it.
   */
  describe('task backend routing matrix', () => {
    // Minimal argument sets: enough to parse, so the backend gate - not
    // argument validation - is what the case observes.
    const SUBCOMMANDS = [
      ['list', []],
      ['lint', []],
      ['new', ['Backend matrix task', '--scaffold']],
      ['establish-baseline', ['T-001']],
      ['authorize-correction', ['T-001']],
      ['prepare-decomposition', ['T-001']],
      ['prepare-dispatch', ['T-001']],
      ['verify-return', ['T-001']],
      ['status', ['T-001', 'blocked']],
    ];
    // The declared support matrix, mirrored here so a change to it is a
    // deliberate test edit rather than a silent behavior drift.
    const SUPPORTED = {
      list: ['files'],
      lint: ['files'],
      new: ['files'],
      'establish-baseline': ['files'],
      'authorize-correction': ['files'],
      'prepare-decomposition': ['files', 'github'],
      'prepare-dispatch': ['files', 'github'],
      'verify-return': ['files', 'github'],
      status: ['files'],
    };

    function targetWithBackend(name, backend) {
      const target = makeTarget(name);
      const projectPath = join(target, '.agenticloop', 'project.md');
      writeFileSync(
        projectPath,
        readFileSync(projectPath, 'utf-8').replace('task_backend: files', `task_backend: ${backend}`),
        'utf-8'
      );
      return target;
    }

    for (const [sub, args] of SUBCOMMANDS) {
      it(`returns one canonical typed envelope for an unsupported backend: task ${sub}`, async () => {
        const target = targetWithBackend(`matrix-unsupported-${sub}`, 'jira');

        const human = await run(['task', sub, ...args, '--target', target]);
        assert.notEqual(human.status, 0, human.stdout + human.stderr);
        assert.match(human.stderr, /Configured task backend 'jira' from project\.md is not supported/);
        assert.match(human.stderr, /supported backends: github, files/);
        // The root diagnostic is emitted before any enumeration or transport.
        assert.match(
          human.stdout + human.stderr,
          /No task inventory was enumerated and no backend transport was contacted/
        );

        const json = await run(['task', sub, ...args, '--json', '--target', target]);
        assert.notEqual(json.status, 0, json.stdout + json.stderr);
        const envelope = JSON.parse(json.stdout);
        assert.equal(envelope.kind, 'agenticloop.validation-result');
        assert.equal(envelope.command, `task ${sub}`);
        assert.equal(envelope.evidenceState, 'malformed');
        assert.equal(envelope.disposition, 'rejected');
        assert.equal(envelope.diagnostics[0].code, 'verification.context.malformed');
        assert.match(
          envelope.diagnostics[0].message,
          /Configured task backend 'jira' from project\.md is not supported/
        );
      });
    }

    for (const [sub, args] of SUBCOMMANDS.filter(([name]) => !SUPPORTED[name].includes('github'))) {
      it(`returns a typed usage result for an incompatible backend: task ${sub}`, async () => {
        const target = targetWithBackend(`matrix-github-${sub}`, 'github');

        const human = await run(['task', sub, ...args, '--target', target]);
        assert.notEqual(human.status, 0, human.stdout + human.stderr);
        assert.match(human.stderr, /Active task backend is 'github' \(from project\.md\)/);
        assert.match(human.stderr, /supports the files backend only/);

        const json = await run(['task', sub, ...args, '--json', '--target', target]);
        assert.notEqual(json.status, 0, json.stdout + json.stderr);
        const envelope = JSON.parse(json.stdout);
        assert.equal(envelope.kind, 'agenticloop.validation-result');
        assert.equal(envelope.command, `task ${sub}`);
        assert.equal(envelope.diagnostics[0].code, 'cli.usage');
        assert.match(envelope.diagnostics[0].message, /Active task backend is 'github'/);
      });
    }

    for (const [sub, args] of SUBCOMMANDS.filter(([name]) => SUPPORTED[name].includes('github'))) {
      it(`admits the github backend past the gate: task ${sub}`, async () => {
        const target = targetWithBackend(`matrix-github-ok-${sub}`, 'github');
        const result = await run(['task', sub, ...args, '--json', '--target', target]);
        // The command still fails on its own missing evidence, but never on the
        // backend gate: no backend diagnostic appears.
        const text = result.stdout + result.stderr;
        assert.doesNotMatch(text, /Active task backend is 'github'/);
        assert.doesNotMatch(text, /is not supported; supported backends/);
      });
    }

    it('never silently selects another backend for a files-only subcommand', async () => {
      const target = targetWithBackend('matrix-no-fallback', 'github');
      const before = existsSync(join(target, '.agenticloop', 'tasks'))
        ? readFileSync(join(target, '.agenticloop', 'project.md'), 'utf-8')
        : null;
      const result = await run(['task', 'new', 'Should not be created', '--scaffold', '--target', target]);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(taskPath(target, 'T-001')), false, 'a refused subcommand must not write a files-backend record');
      assert.equal(readFileSync(join(target, '.agenticloop', 'project.md'), 'utf-8'), before);
    });
  });

  it('requires block category for blocked status and lint catches missing block_category', async () => {
    const target = makeTarget('blocked');
    assertOk(await run(['task', 'new', 'Blocked task', '--scaffold', '--target', target]));

    const blocked = await run(['task', 'status', 'T-001', 'blocked', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /requires --block-category/);

    let content = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    content = content.replace(/^status: draft$/m, 'status: blocked');
    writeFileSync(taskPath(target, 'T-001'), content, 'utf-8');
    const lint = await run(['task', 'lint', 'T-001', '--target', target]);
    assert.notEqual(lint.status, 0);
    assert.match(lint.stdout, /missing required frontmatter field 'block_category'/);
  });

  it('warns when accepted churn signals have empty Outcome', async () => {
    const target = makeTarget('outcome-warning');
    // Accepted requires review_status: accepted; the Revision Log is the churn signal.
    writeAcceptedTask(target, 'T-010', { reviewStatus: 'accepted' });

    const result = await run(['task', 'lint', 'T-010', '--target', target, '--json']);
    assertOk(result);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload[0].errors.length, 0);
    assert.ok(payload[0].warnings.some(w => w.includes("empty '## Outcome' section")));
  });

  it('lints project-fact and decision triage with the same local reference context as validation', async () => {
    const target = makeTarget('verification-context');
    assertOk(await run(['task', 'new', 'Verify local references', '--scaffold', '--target', target]));
    const projectPath = join(target, '.agenticloop', 'project.md');
    const project = readFileSync(projectPath, 'utf-8').replace(
      'No project-wide verification operating facts are currently recorded.',
      PROJECT_FACT
    );
    writeFileSync(projectPath, project, 'utf-8');

    const path = taskPath(target, 'T-001');
    const original = readFileSync(path, 'utf-8');
    writeFileSync(path, original.replace(
      '## Verification Attempts\n\nNo verification attempts are currently recorded.',
      verificationHistory('project_fact', 'VF-full-suite')
    ), 'utf-8');
    assertOk(await run(['task', 'lint', 'T-001', '--target', target]));

    writeFileSync(path, readFileSync(path, 'utf-8').replace('Reference: VF-full-suite', 'Reference: VF-missing'), 'utf-8');
    const missingFact = await run(['task', 'lint', 'T-001', '--target', target]);
    assert.notEqual(missingFact.status, 0);
    assert.match(missingFact.stdout, /missing project verification fact 'VF-missing'/);

    mkdirSync(join(target, '.agenticloop', 'decisions'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'decisions', 'D-2026-07-17-001.md'), '# Decision\n', 'utf-8');
    writeFileSync(path, original.replace(
      '## Verification Attempts\n\nNo verification attempts are currently recorded.',
      verificationHistory('decision', 'D-2026-07-17-001')
    ), 'utf-8');
    assertOk(await run(['task', 'lint', 'T-001', '--target', target]));

    rmSync(join(target, '.agenticloop', 'decisions', 'D-2026-07-17-001.md'));
    const missingDecision = await run(['task', 'lint', 'T-001', '--target', target]);
    assert.notEqual(missingDecision.status, 0);
    assert.match(missingDecision.stdout, /missing decision 'D-2026-07-17-001'/);
  });

  it('fails with exit 2 when a task subcommand receives an unknown option', async () => {
    const target = makeTarget('unknown-option');
    assertOk(await run(['task', 'new', 'Warn on unknown option', '--scaffold', '--target', target]));

    const result = await run(['task', 'list', '--target', target, '--bogus']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option '--bogus'/);
  });

  it('exposes the canonical public handoff producer paths with JSON-only stdout', async () => {
    const target = makeTarget('public-handoff');
    const packet = join(target, 'dispatch.json');
    const checks = join(target, 'checks.json');
    const returned = join(target, 'return.json');

    const init = await run(['task', 'check-evidence-init', 'T-001', '--packet', packet, '--output', checks, '--json', '--target', target]);
    assert.notEqual(init.status, 0);
    assert.equal(init.stderr, '');
    const malformed = JSON.parse(init.stdout);
    assert.equal(malformed.diagnostics[0].code, 'verification.context.malformed');

    mkdirSync(packet);
    const directory = await run(['task', 'prepare-return', 'T-001', '--packet', packet, '--check-evidence', checks, '--outcome', 'implementation_ready_for_review', '--output', returned, '--json', '--target', target]);
    assert.notEqual(directory.status, 0);
    assert.equal(directory.stderr, '');
    assert.equal(JSON.parse(directory.stdout).diagnostics[0].code, 'verification.context.malformed');
    assert.equal(statSync(packet).isDirectory(), true);
  });

  it('documents the ordinary public handoff command paths and target-relative file inputs', async () => {
    const help = await run(['help', 'task', 'prepare-return']);
    assertOk(help);
    assert.match(help.stdout, /prepare-return/);
    assert.match(help.stdout, /target-relative/);
    const verifyHelp = await run(['help', 'task', 'verify-return']);
    assertOk(verifyHelp);
    assert.match(verifyHelp.stdout, /--from-current-repository/);
  });

  it('creates closed required-check evidence from an installed dispatch fixture', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'public-check-evidence');
    const packetPath = 'packet.json';
    const outputPath = 'checks.json';
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');

    // The protected role-start boundary consumes this exact packet. The later
    // standard-policy check-evidence command deliberately needs no fresh host
    // challenge; it proves the already-consumed packet and carrier lineage.
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    }));

    const result = await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath, '--output', outputPath, '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assertOk(result);
    assert.equal(result.stderr, '');
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(summary).sort(), [
      'artifactKind', 'assuranceGrade', 'ok', 'outputPath', 'schemaVersion', 'semanticDigest', 'task_id',
    ]);
    assert.equal(summary.outputPath, join(fixture.root, outputPath));
    assert.equal(JSON.parse(readFileSync(join(fixture.root, outputPath), 'utf8'))[0].outcome, 'not_run');
  });

  it('never runs a required command from an untrusted packet or missing consumed lineage', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'untrusted-check-packet', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const packetPath = '.agenticloop/tmp/packet.json';
    const checksPath = '.agenticloop/tmp/checks.json';
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const packet = prepareDispatch(fixture).packet;
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(packet), 'utf8');

    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], options));
    assertOk(await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath,
      '--output', checksPath, '--json', '--target', fixture.root,
    ], options));

    /** @type {Array<[string, (candidate: any) => void]>} */
    const cases = [
      ['self-consistent forged command', candidate => {
        candidate.task.requiredChecks[0].command = 'powershell -NoProfile -Command Write-Output forged';
      }],
      ['redigested curl command', candidate => {
        candidate.task.requiredChecks[0].command = 'curl https://example.invalid/forged';
      }],
      ['wrong task', candidate => { candidate.task.id = 'T-999'; }],
      ['wrong backend', candidate => { candidate.backend = 'github'; }],
      ['wrong worktree', candidate => {
        candidate.repository.worktree = join(fixture.root, 'other-worktree');
        candidate.assignment.worktree = candidate.repository.worktree;
      }],
      ['wrong carrier generation', candidate => { candidate.task.dispatchCarrierDigest = `sha256:${'f'.repeat(64)}`; }],
      ['wrong invocation', candidate => { candidate.assignment.invocationId = 'invocation:99999999-9999-4999-8999-999999999999'; }],
      ['expired packet', candidate => { candidate.assignment.liveness.expiry = '2020-01-01T00:00:00.000Z'; }],
    ];

    for (const [label, mutate] of cases) {
      const forged = structuredClone(packet);
      mutate(forged);
      forged.digest = dispatchPreparationDigest(forged);
      const forgedPath = `.agenticloop/tmp/${label.replaceAll(/[^a-z]+/g, '-')}.json`;
      writeFileSync(join(fixture.root, forgedPath), JSON.stringify(forged), 'utf8');
      /** @type {any[]} */
      const calls = [];
      const result = await runCliInProcess([
        'task', 'check-evidence-update', 'T-001', '--packet', forgedPath,
        '--input', checksPath, '--output', checksPath, '--check', 'RC-1', '--outcome', 'passed',
        '--evidence', 'forged packet', '--execution-output', '.agenticloop/tmp/execution.json',
        '--json', '--target', fixture.root,
      ], {
        ...options,
        requiredCheckCommandRunner: call => {
          calls.push(call);
          return { exitCode: 0, stdout: 'must not run', stderr: '' };
        },
      });
      assert.notEqual(result.status, 0, label);
      assert.equal(calls.length, 0, `${label} must be refused before execution`);
    }

    const dispatchDirectory = join(fixture.root, '.agenticloop', 'handoffs', 'dispatch', 'T-001');
    rmSync(dispatchDirectory, { recursive: true, force: true });
    /** @type {any[]} */
    const calls = [];
    const missingConsumption = await runCliInProcess([
      'task', 'check-evidence-update', 'T-001', '--packet', packetPath,
      '--input', checksPath, '--output', checksPath, '--check', 'RC-1', '--outcome', 'passed',
      '--evidence', 'missing consumption', '--execution-output', '.agenticloop/tmp/execution.json',
      '--json', '--target', fixture.root,
    ], {
      ...options,
      requiredCheckCommandRunner: call => {
        calls.push(call);
        return { exitCode: 0, stdout: 'must not run', stderr: '' };
      },
    });
    assert.notEqual(missingConsumption.status, 0);
    assert.equal(calls.length, 0, 'missing dispatch consumption must be refused before execution');
  });

  it('does not manufacture check evidence from invalid packets or public paths', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'invalid-check-evidence-packet');
    const packet = prepareDispatch(fixture).packet;
    const outside = join(tmpDir, 'outside-packet.json');
    const packetPath = '.agenticloop/tmp/packet.json';
    const checksPath = '.agenticloop/tmp/checks.json';
    const options = { operatorTrustRoot: fixture.operatorTrustRoot };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(outside, JSON.stringify(packet), 'utf8');
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(packet), 'utf8');

    const forged = structuredClone(packet);
    forged.task.requiredChecks[0].command = 'node forged-target-script.js';
    forged.digest = dispatchPreparationDigest(forged);
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(forged), 'utf8');

    for (const input of [outside, '../outside-packet.json']) {
      const init = await runCliInProcess([
        'task', 'check-evidence-init', 'T-001', '--packet', input,
        '--output', checksPath, '--json', '--target', fixture.root,
      ], options);
      assert.notEqual(init.status, 0);
      assert.equal(existsSync(join(fixture.root, checksPath)), false);
    }

    const forgedInit = await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath,
      '--output', checksPath, '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(forgedInit.status, 0);
    assert.equal(existsSync(join(fixture.root, checksPath)), false);
  });

  it('executes the exact required argv itself and refuses a passed claim without execution output', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'fabricated-check-evidence');
    const packetPath = 'packet.json';
    const checksPath = 'checks.json';
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    }));
    assertOk(await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath, '--output', checksPath, '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot }));
    const result = await runCliInProcess([
      'task', 'check-evidence-update', 'T-001', '--packet', packetPath, '--input', checksPath, '--output', checksPath,
      '--check', 'RC-1', '--outcome', 'passed', '--evidence', 'fabricated pass', '--exit-code', '0', '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.notEqual(result.status, 0);
    assert.match(JSON.parse(result.stdout).diagnostics[0].message, /execution-output/);
  });

  it('refuses unsafe check-evidence write destinations before running a required command', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'unsafe-check-evidence-destinations', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const packetPath = '.agenticloop/tmp/packet.json';
    const checksPath = '.agenticloop/tmp/checks.json';
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], options));
    assertOk(await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath,
      '--output', checksPath, '--json', '--target', fixture.root,
    ], options));

    const inputBefore = readFileSync(join(fixture.root, checksPath), 'utf8');
    const outsideDirectory = join(tmpDir, 'unsafe-check-evidence-output');
    const outside = join(outsideDirectory, 'sentinel.json');
    mkdirSync(outsideDirectory);
    writeFileSync(outside, 'sentinel', 'utf8');
    const leafChecks = '.agenticloop/tmp/checks-link.json';
    const leafExecution = '.agenticloop/tmp/execution-link.json';
    const directoryOutput = '.agenticloop/tmp/checks-directory';
    const ancestorLink = '.agenticloop/tmp/linked-output';
    symlinkSync(IS_WINDOWS ? outsideDirectory : outside, join(fixture.root, leafChecks), IS_WINDOWS ? 'junction' : 'file');
    symlinkSync(IS_WINDOWS ? outsideDirectory : outside, join(fixture.root, leafExecution), IS_WINDOWS ? 'junction' : 'file');
    mkdirSync(join(fixture.root, directoryOutput));
    symlinkSync(outsideDirectory, join(fixture.root, ancestorLink), IS_WINDOWS ? 'junction' : 'dir');

    const cases = [
      ['checks output leaf symlink', leafChecks, '.agenticloop/tmp/execution-safe.json'],
      ['execution output leaf symlink', '.agenticloop/tmp/checks-safe.json', leafExecution],
      ['directory checks output', directoryOutput, '.agenticloop/tmp/execution-safe.json'],
      ['symlinked checks output ancestor', `${ancestorLink}/checks.json`, '.agenticloop/tmp/execution-safe.json'],
    ];
    for (const [label, outputPath, executionOutputPath] of cases) {
      const calls = [];
      const result = await runCliInProcess([
        'task', 'check-evidence-update', 'T-001', '--packet', packetPath,
        '--input', checksPath, '--output', outputPath, '--check', 'RC-1', '--outcome', 'passed',
        '--evidence', 'must not run', '--execution-output', executionOutputPath,
        '--json', '--target', fixture.root,
      ], {
        ...options,
        requiredCheckCommandRunner: call => {
          calls.push(call);
          return { exitCode: 0, stdout: 'must not run', stderr: '' };
        },
      });
      assert.notEqual(result.status, 0, label);
      assert.equal(calls.length, 0, `${label} must be rejected before command execution`);
      assert.equal(readFileSync(join(fixture.root, checksPath), 'utf8'), inputBefore, `${label} must not mutate check evidence`);
    }
    assert.equal(readFileSync(outside, 'utf8'), 'sentinel', 'leaf links must not be written through');
    assert.equal(lstatSync(join(fixture.root, leafChecks)).isSymbolicLink(), true);
    assert.equal(lstatSync(join(fixture.root, leafExecution)).isSymbolicLink(), true);
    assert.equal(statSync(join(fixture.root, directoryOutput)).isDirectory(), true);
    assert.equal(existsSync(join(outsideDirectory, 'checks.json')), false);
  });

  it('rejects a shell-shaped required command rather than executing a different command', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'unsafe-check-command', {
      requiredChecksText: '- [RC-1] command: `node --version; node --version`\n- [RC-2] manual: Inspect the final state.',
    });
    const packetPath = 'packet.json';
    const checksPath = 'checks.json';
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    }));
    assertOk(await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath, '--output', checksPath, '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot }));
    const result = await runCliInProcess([
      'task', 'check-evidence-update', 'T-001', '--packet', packetPath, '--input', checksPath, '--output', checksPath,
      '--check', 'RC-1', '--outcome', 'passed', '--evidence', 'claimed pass', '--execution-output', 'rc-1.json', '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.notEqual(result.status, 0);
    assert.match(JSON.parse(result.stdout).diagnostics[0].message, /safe inert argv/);
    assert.equal(existsSync(join(fixture.root, 'rc-1.json')), false);
  });

  it('rejects hand-authored passed checks and derives an Engineer return from CLI-executed checks and current Git facts', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'public-return-producer', {
      requiredChecksText: '- [RC-1] command: `node --version`\n- [RC-2] command: `node --version`',
    });
    const packetPath = '.agenticloop/tmp/dispatch.json';
    const checksPath = '.agenticloop/tmp/checks.json';
    const returnPath = '.agenticloop/tmp/return.json';
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');

    const start = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], options);
    assertOk(start);

    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    fixtureGit(fixture.root, ['add', 'src/existing.js']);
    fixtureGit(fixture.root, ['commit', '-m', 'implement return\n\nTask: T-001\nAgent: engineer']);
    const productHead = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);

    const artifact = await runCliInProcess([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', currentDigest(fixture.root, 'T-001'), '--product-head', productHead,
      '--json', '--target', fixture.root,
    ], options);
    assertOk(artifact);
    fixtureGit(fixture.root, ['add', '.agenticloop/tasks/T-001.md', '.agenticloop/handoffs/task-mutations']);
    fixtureGit(fixture.root, ['commit', '-m', 'record implementation artifact evidence\n\nTask: T-001\nAgent: engineer']);

    const checks = await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath, '--output', checksPath,
      '--json', '--target', fixture.root,
    ], options);
    assertOk(checks);
    for (const check of JSON.parse(readFileSync(join(fixture.root, checksPath), 'utf8'))) {
      const executionOutputPath = `.agenticloop/tmp/${check.id}.execution.json`;
      const updated = await runCliInProcess([
        'task', 'check-evidence-update', 'T-001', '--packet', packetPath,
        '--input', checksPath, '--output', checksPath, '--check', check.id,
        '--outcome', 'passed', '--evidence', `${check.id} passed`,
        ...(check.kind === 'command' ? ['--execution-output', executionOutputPath] : []),
        '--json', '--target', fixture.root,
      ], options);
      assertOk(updated);
      if (check.kind === 'command') {
        const execution = JSON.parse(readFileSync(join(fixture.root, executionOutputPath), 'utf8'));
        assert.equal(execution.check.instruction, check.command);
        assert.equal(execution.check.command, 'node');
        assert.deepEqual(execution.check.args, ['--version']);
        assert.equal(execution.execution.childExitCode, 0);
      }
    }

    const authenticChecks = readFileSync(join(fixture.root, checksPath), 'utf8');
    const handAuthoredChecks = JSON.parse(authenticChecks).map(check => check.kind === 'command' ? {
      ...check,
      evidence: 'hand-authored passed summary',
      exitCode: 0,
      executionEvidence: undefined,
    } : check);
    for (const check of handAuthoredChecks) delete check.executionEvidence;
    writeFileSync(join(fixture.root, checksPath), JSON.stringify(handAuthoredChecks), 'utf8');
    const forged = await runCliInProcess([
      'task', 'prepare-return', 'T-001', '--packet', packetPath, '--check-evidence', checksPath,
      '--outcome', 'implementation_ready_for_review', '--output', returnPath,
      '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(forged.status, 0);
    assert.match(JSON.parse(forged.stdout).diagnostics[0].message, /closed CLI execution artifact path and digest/);
    writeFileSync(join(fixture.root, checksPath), authenticChecks, 'utf8');

    const result = await runCliInProcess([
      'task', 'prepare-return', 'T-001', '--packet', packetPath, '--check-evidence', checksPath,
      '--outcome', 'implementation_ready_for_review', '--output', returnPath,
      '--json', '--target', fixture.root,
    ], options);
    assertOk(result);
    assert.equal(result.stderr, '');
    const summary = JSON.parse(result.stdout);
    const roleReturn = JSON.parse(readFileSync(join(fixture.root, returnPath), 'utf8'));
    assert.equal(summary.semanticDigest, roleReturn.digest);
    assert.equal(roleReturn.productHead, productHead);
    assert.equal(roleReturn.outcome.kind, 'implementation_ready_for_review');

    const verified = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
      '--from-current-repository', '--json', '--target', fixture.root,
    ], options);
    assertOk(verified);
    const records = readdirSync(join(fixture.root, '.agenticloop', 'returns', 'verifications'));
    assert.equal(records.length, 1);
    const persisted = JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'returns', 'verifications', records[0]), 'utf8'));
    assert.equal(persisted.requiredCheckEvidenceAssurance, 'unverified');
    assert.equal(persisted.evidence.producerIdentityAuthenticated, false);
  });

  it('prepares an ordinary derived dispatch from durable selectors without --input', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'derived-dispatch');
    const decomposition = JSON.parse(readFileSync(
      join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json'), 'utf8'));
    // The semantic dependency source identity is not a path; the persisted
    // target-relative sourceRef is the only artifact selector.
    assert.equal(decomposition.scan.readinessContext.dependencies.source, 'files:.agenticloop/tasks');
    assert.equal(decomposition.scan.readinessContext.dependencies.sourceRef, 'dependencies.json');
    const args = [
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer',
      '--json', '--target', fixture.root,
    ];
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };
    const first = await runCliInProcess(args, options);
    assertOk(first);
    const packet = JSON.parse(first.stdout);
    assert.equal(packet.task.id, 'T-001');
    assert.equal(packet.assignment.host, 'opencode');
    assert.equal(packet.assignment.roleId, 'engineer');
    // The derived command is read-only and reusable: a second run succeeds and
    // the committed worktree is untouched.
    const second = await runCliInProcess(args, options);
    assertOk(second);
    assert.equal(fixtureGit(fixture.root, ['status', '--porcelain']), '');
  });

  it('fails closed with a typed regeneration diagnostic when the persisted selector is missing', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'missing-revalidation-selector');
    const sourcePath = join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json');
    const decomposition = JSON.parse(readFileSync(sourcePath, 'utf8'));
    delete decomposition.scan.readinessContext.dependencies.sourceRef;
    writeFileSync(sourcePath, JSON.stringify(decomposition, null, 2), 'utf8');
    const result = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer',
      '--json', '--target', fixture.root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    });
    assert.notEqual(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, false);
    assert.match(value.diagnostics[0].message, /dependency revalidation selector/);
    assert.match(value.diagnostics[0].message, /task prepare-decomposition T-001/);
  });

  it('fails closed on an escaping persisted selector rather than opening it as a path', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'escaping-revalidation-selector');
    const sourcePath = join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json');
    const decomposition = JSON.parse(readFileSync(sourcePath, 'utf8'));
    decomposition.scan.readinessContext.dependencies.sourceRef = '../outside.json';
    writeFileSync(sourcePath, JSON.stringify(decomposition, null, 2), 'utf8');
    const result = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer',
      '--json', '--target', fixture.root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    });
    assert.notEqual(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, false);
    assert.equal(existsSync(join(fixture.root, '..', 'outside.json')), false);
  });

  it('rejects command execution evidence replayed after the repository head changes', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'stale-command-execution', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const packetPath = '.agenticloop/tmp/dispatch.json';
    const checksPath = '.agenticloop/tmp/checks.json';
    const executionPath = '.agenticloop/tmp/RC-1.execution.json';
    const returnPath = '.agenticloop/tmp/return.json';
    const options = { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], options));
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    fixtureGit(fixture.root, ['add', 'src/existing.js']);
    fixtureGit(fixture.root, ['commit', '-m', 'implement return\n\nTask: T-001\nAgent: engineer']);
    const productHead = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    assertOk(await runCliInProcess([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', currentDigest(fixture.root, 'T-001'), '--product-head', productHead, '--json', '--target', fixture.root,
    ], options));
    fixtureGit(fixture.root, ['add', '.agenticloop/tasks/T-001.md', '.agenticloop/handoffs/task-mutations']);
    fixtureGit(fixture.root, ['commit', '-m', 'record implementation artifact evidence\n\nTask: T-001\nAgent: engineer']);
    assertOk(await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath, '--output', checksPath, '--json', '--target', fixture.root,
    ], options));
    assertOk(await runCliInProcess([
      'task', 'check-evidence-update', 'T-001', '--packet', packetPath, '--input', checksPath, '--output', checksPath,
      '--check', 'RC-1', '--outcome', 'passed', '--evidence', 'RC-1 passed', '--execution-output', executionPath,
      '--json', '--target', fixture.root,
    ], options));
    fixtureGit(fixture.root, ['commit', '--allow-empty', '-m', 'advance repository after check\n\nTask: T-001\nAgent: engineer']);
    const stale = await runCliInProcess([
      'task', 'prepare-return', 'T-001', '--packet', packetPath, '--check-evidence', checksPath,
      '--outcome', 'implementation_ready_for_review', '--output', returnPath, '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(stale.status, 0);
    assert.match(JSON.parse(stale.stdout).diagnostics[0].message, /execution evidence does not match the expected dispatch binding/);
  });

  it('rejects execution evidence replayed from a different dispatch invocation', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'replayed-dispatch-execution', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const firstPacketPath = '.agenticloop/tmp/first-dispatch.json';
    const secondPacketPath = '.agenticloop/tmp/second-dispatch.json';
    const checksPath = '.agenticloop/tmp/checks.json';
    const executionPath = '.agenticloop/tmp/RC-1.execution.json';
    const returnPath = '.agenticloop/tmp/return.json';
    const options = { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const first = prepareDispatch(fixture).packet;
    const second = prepareDispatch(fixture).packet;
    writeFileSync(join(fixture.root, firstPacketPath), JSON.stringify(first), 'utf8');
    writeFileSync(join(fixture.root, secondPacketPath), JSON.stringify(second), 'utf8');
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', firstPacketPath, '--json', '--target', fixture.root,
    ], options));
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    fixtureGit(fixture.root, ['add', 'src/existing.js']);
    fixtureGit(fixture.root, ['commit', '-m', 'implement return\n\nTask: T-001\nAgent: engineer']);
    const productHead = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    assertOk(await runCliInProcess([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', currentDigest(fixture.root, 'T-001'), '--product-head', productHead, '--json', '--target', fixture.root,
    ], options));
    fixtureGit(fixture.root, ['add', '.agenticloop/tasks/T-001.md', '.agenticloop/handoffs/task-mutations']);
    fixtureGit(fixture.root, ['commit', '-m', 'record implementation artifact evidence\n\nTask: T-001\nAgent: engineer']);
    assertOk(await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', firstPacketPath, '--output', checksPath, '--json', '--target', fixture.root,
    ], options));
    assertOk(await runCliInProcess([
      'task', 'check-evidence-update', 'T-001', '--packet', firstPacketPath, '--input', checksPath, '--output', checksPath,
      '--check', 'RC-1', '--outcome', 'passed', '--evidence', 'RC-1 passed', '--execution-output', executionPath,
      '--json', '--target', fixture.root,
    ], options));
    const replayed = await runCliInProcess([
      'task', 'prepare-return', 'T-001', '--packet', secondPacketPath, '--check-evidence', checksPath,
      '--outcome', 'implementation_ready_for_review', '--output', returnPath, '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(replayed.status, 0);
    assert.match(JSON.parse(replayed.stdout).diagnostics[0].message, /exact packet invocation|does not bind exact target CLI execution evidence/);
  });

  it('fails closed for trailing, multiple, and directory JSON public handoff inputs', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'public-json-failures');
    const packet = prepareDispatch(fixture).packet;
    const packetPath = join(fixture.root, 'packet.json');
    const outputPath = join(fixture.root, 'checks.json');
    const cases = [
      ['trailing.json', `${JSON.stringify(packet)} trailing`],
      ['multiple.json', `${JSON.stringify(packet)}\n${JSON.stringify(packet)}`],
    ];
    for (const [name, content] of cases) {
      writeFileSync(join(fixture.root, name), content, 'utf8');
      const result = await runCliInProcess([
        'task', 'check-evidence-init', 'T-001', '--packet', name, '--output', outputPath, '--json', '--target', fixture.root,
      ], { operatorTrustRoot: fixture.operatorTrustRoot });
      assert.notEqual(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).diagnostics[0].code, 'verification.context.malformed');
    }
    mkdirSync(join(fixture.root, 'directory.json'));
    const directory = await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', 'directory.json', '--output', outputPath, '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.notEqual(directory.status, 0);
    assert.equal(directory.stderr, '');
    assert.equal(JSON.parse(directory.stdout).diagnostics[0].code, 'verification.context.malformed');
  });

  // --- Lifecycle transition enforcement ---

  it('allows draft -> agent-ready', async () => {
    const target = makeTarget('trans-dr-ar');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    await establishBaseline(target);
    const result = await run(['task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentDigest(target, 'T-001'), '--base', baseTree(target), '--dependencies', dependencySnapshot(target), '--target', target]);
    assertOk(result);
  });

  it('allows draft -> blocked with --note', async () => {
    const target = makeTarget('trans-dr-bl');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    const result = await run(['task', 'status', 'T-001', 'blocked', '--expect-digest', currentDigest(target, 'T-001'), '--block-category', 'dependency', '--note', 'Waiting on API', '--target', target]);
    assertOk(result);
  });

  it('rejects draft -> in-progress', async () => {
    const target = makeTarget('trans-dr-ip');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    const result = await run(['task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot transition from 'draft' to 'in-progress'/);
  });

  it('rejects draft -> accepted', async () => {
    const target = makeTarget('trans-dr-ac');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    const result = await run(['task', 'status', 'T-001', 'accepted', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
    // Should fail on both transition and acceptance gate
  });

  it('rejects draft -> closed', async () => {
    const target = makeTarget('trans-dr-cl');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    const result = await run(['task', 'status', 'T-001', 'closed', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
  });

  it('rejects agent-ready -> in-progress without a canonical dispatch', async () => {
    const target = makeTarget('trans-ar-ip');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    await establishBaseline(target);
    assertOk(await run(['task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentDigest(target, 'T-001'), '--base', baseTree(target), '--dependencies', dependencySnapshot(target), '--target', target]));
    const result = await run(['task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(target, 'T-001'), '--note', 'Starting', '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical prepared dispatch/);
  });

  it('rejects in-progress -> accepted without the canonical handoff chain', async () => {
    const target = makeTarget('trans-ip-ac');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    await establishBaseline(target);
    assertOk(await run(['task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentDigest(target, 'T-001'), '--base', baseTree(target), '--dependencies', dependencySnapshot(target), '--target', target]));
    writeFileSync(
      taskPath(target, 'T-001'),
      readFileSync(taskPath(target, 'T-001'), 'utf-8').replace(/^status: agent-ready$/m, 'status: in-progress'),
      'utf-8'
    );

    // Write required evidence into the task record
    let content = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    content = content.replace('review_status:', 'review_status: accepted');
    content = content.replace('review_mode:', 'review_mode: single_agent_fallback');
    content = content.replace('reviewed_artifact:', 'reviewed_artifact: commit:abc123');
    content = content.replace('implementation_artifact:', 'implementation_artifact: commit:abc123');
    // Add the required sections that the template doesn't include
    content += '\n## Scope Completed\nDone.\n';
    content += '\n## Evidence\n- npm test passed.\n';
    writeFileSync(taskPath(target, 'T-001'), content, 'utf-8');

    const result = await run(['task', 'status', 'T-001', 'accepted', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical verified return|canonical dispatch consumption/);
  });

  it('rejects accepted -> in-progress (terminal without reopen)', async () => {
    const target = makeTarget('trans-ac-ip');
    writeAcceptedTask(target, 'T-001');
    const result = await run(['task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot transition from 'accepted' to 'in-progress'/);
  });

  it('rejects generic accepted -> closed without the canonical handoff chain', async () => {
    const target = makeTarget('trans-ac-cl');
    writeAcceptedTask(target, 'T-001');
    // accepted -> closed revalidates acceptance gate: review_status must be 'accepted'
    let content = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    content = content.replace('review_status: needs_revision', 'review_status: accepted');
    writeFileSync(taskPath(target, 'T-001'), content, 'utf-8');
    const result = await run(['task', 'status', 'T-001', 'closed', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical verified return|canonical dispatch consumption/);
  });

  it('rejects accepted -> closed when review_status is not accepted', async () => {
    const target = makeTarget('trans-ac-cl-rs');
    writeAcceptedTask(target, 'T-001');
    // review_status is needs_revision — closing should fail
    const result = await run(['task', 'status', 'T-001', 'closed', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /review_status must be 'accepted'/);
  });

  it('rejects agent-ready -> closed', async () => {
    const target = makeTarget('trans-ar-cl');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    await establishBaseline(target);
    assertOk(await run(['task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentDigest(target, 'T-001'), '--base', baseTree(target), '--dependencies', dependencySnapshot(target), '--target', target]));
    const result = await run(['task', 'status', 'T-001', 'closed', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
  });
});

describe('return evidence, cancellation provenance, and current-repository verification', () => {
  function lineageDigests(root, taskId) {
    const dispatchDir = join(root, '.agenticloop', 'handoffs', 'dispatch', taskId);
    const consumption = JSON.parse(readFileSync(join(dispatchDir, readdirSync(dispatchDir)[0]), 'utf8'));
    const evidenceDir = join(root, '.agenticloop', 'handoffs', 'task-mutations', taskId);
    const receipts = existsSync(evidenceDir)
      ? readdirSync(evidenceDir).sort().map(name => JSON.parse(readFileSync(join(evidenceDir, name), 'utf8')))
      : [];
    const ordered = [];
    let predecessor = consumption.digest;
    while (receipts.length > 0) {
      const receipt = receipts.find(item => item.predecessor.digest === predecessor);
      assert.ok(receipt, 'every evidence receipt must continue the consumed dispatch lineage');
      receipts.splice(receipts.indexOf(receipt), 1);
      ordered.push(receipt.digest);
      predecessor = receipt.digest;
    }
    return { dispatchConsumptionDigest: consumption.digest, evidenceMutationReceiptDigests: ordered };
  }

  function buildEvidence(fixture, packet, productHead, checks) {
    const workflowHead = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    const changedPaths = fixtureGit(fixture.root, ['diff', '--name-only', `${packet.repository.head}..${workflowHead}`])
      .split(/\r?\n/).filter(Boolean).sort();
    const productRangePaths = fixtureGit(fixture.root, ['diff', '--name-only', `${packet.repository.head}..${productHead}`])
      .split(/\r?\n/).filter(Boolean).sort();
    const productChangedPaths = productRangePaths.filter(path => path.startsWith('src/'));
    const evidence = repositoryEvidence(packet, { head: productHead, changedPaths: productChangedPaths, checks });
    evidence.workflowHead = workflowHead;
    evidence.task.currentCarrierDigest = currentDigest(fixture.root, 'T-001');
    evidence.productChangedPaths = productChangedPaths;
    evidence.workflowChangedPaths = changedPaths.filter(path => !productChangedPaths.includes(path));
    evidence.productAttribution = {
      range: { base: packet.repository.head, head: productHead },
      commits: fixtureGit(fixture.root, ['rev-list', '--reverse', `${packet.repository.head}..${productHead}`])
        .split(/\r?\n/).filter(Boolean),
    };
    evidence.carrierLineage = lineageDigests(fixture.root, 'T-001');
    return evidence;
  }

  async function engineerStart(fixture, packetPath, options) {
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], options));
    fixtureGit(fixture.root, ['add', '.agenticloop/tasks', '.agenticloop/handoffs']);
    fixtureGit(fixture.root, ['commit', '-m', 'Start Engineer work\n\nTask: T-001\nAgent: engineer']);
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    fixtureGit(fixture.root, ['add', 'src/existing.js']);
    fixtureGit(fixture.root, ['commit', '-m', 'implement return\n\nTask: T-001\nAgent: engineer']);
    const productHead = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    assertOk(await runCliInProcess([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', currentDigest(fixture.root, 'T-001'), '--product-head', productHead,
      '--json', '--target', fixture.root,
    ], options));
    fixtureGit(fixture.root, ['add', '.agenticloop/tasks/T-001.md', '.agenticloop/handoffs/task-mutations']);
    fixtureGit(fixture.root, ['commit', '-m', 'record implementation artifact evidence\n\nTask: T-001\nAgent: engineer']);
    return productHead;
  }

  it('rejects stripped current execution evidence at the receiving boundary', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'receiving-boundary-evidence', {
      requiredChecksText: '- [RC-1] command: `node --version`\n- [RC-2] command: `node --version`',
    });
    const packetPath = '.agenticloop/tmp/dispatch.json';
    const returnPath = '.agenticloop/tmp/return.json';
    const evidencePath = '.agenticloop/tmp/evidence.json';
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const packet = prepareDispatch(fixture).packet;
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(packet), 'utf8');
    const productHead = await engineerStart(fixture, packetPath, options);

    // A current return whose passed command check lacks an artifact reference
    // is rejected, and the packet-bound contract cannot be removed to weaken it.
    const currentVersionChecks = [
      { id: 'RC-1', kind: 'command', command: 'node --version', outcome: 'passed', exitCode: 0, evidence: 'v18', executionEvidence: null },
      { id: 'RC-2', kind: 'command', command: 'node --version', outcome: 'passed', exitCode: 0, evidence: 'v18', executionEvidence: null },
    ];
    writeFileSync(join(fixture.root, returnPath), JSON.stringify(readyReturn(packet, buildEvidence(fixture, packet, productHead, currentVersionChecks)), null, 2), 'utf8');
    writeFileSync(join(fixture.root, evidencePath), JSON.stringify(buildEvidence(fixture, packet, productHead, currentVersionChecks), null, 2), 'utf8');
    const missingArtifact = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
      '--repository-evidence', evidencePath, '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(missingArtifact.status, 0);
    assert.match(JSON.parse(missingArtifact.stdout).diagnostics[0].message, /executionEvidence|checks do not match/);

    // A non-passed command check must not carry an artifact reference either.
    const nonPassedWithArtifact = [
      { id: 'RC-1', kind: 'command', command: 'node --version', outcome: 'not_run', exitCode: -1, evidence: 'not run', executionEvidence: { path: 'x.json', digest: `sha256:agenticloop.execution-evidence.v3:${'a'.repeat(64)}` } },
      { id: 'RC-2', kind: 'command', command: 'node --version', outcome: 'not_run', exitCode: -1, evidence: 'not run', executionEvidence: null },
    ];
    const blockedEvidence = buildEvidence(fixture, packet, productHead, nonPassedWithArtifact);
    const blockedReturn = createRoleReturn({
      producerRole: 'engineer',
      packet: { packetId: packet.packetId, digest: packet.digest },
      task: { backend: 'files', id: 'T-001', ...blockedEvidence.task },
      worktree: blockedEvidence.worktree,
      branch: blockedEvidence.branch,
      productBaseHead: blockedEvidence.productBaseHead,
      productHead: blockedEvidence.productHead,
      workflowHead: blockedEvidence.workflowHead,
      candidateHead: null,
      productChangedPaths: blockedEvidence.productChangedPaths,
      workflowChangedPaths: blockedEvidence.workflowChangedPaths,
      checks: blockedEvidence.checks.map(check => check.kind === 'command'
        ? { ...check, executionEvidence: null }
        : check),
      productAttribution: blockedEvidence.productAttribution,
      pr: blockedEvidence.pr,
      carrierLineage: blockedEvidence.carrierLineage,
      outcome: { kind: 'implementation_blocked', completion: false, authority: 'non_authoritative_role_outcome' },
      disposition: 'blocked',
      blocker: {
        category: 'environment',
        evidence: { kind: 'command_failure', detail: 'sandbox unavailable' },
        resumeOwner: 'engineer',
        resumeTransition: 'implementation_resume',
        resumePreconditions: { items: ['Restore the execution environment.'], justification: null },
      },
      freshness: { invalidatedBy: packet.freshness.invalidatedBy },
    });
    writeFileSync(join(fixture.root, returnPath), JSON.stringify(blockedReturn, null, 2), 'utf8');
    writeFileSync(join(fixture.root, evidencePath), JSON.stringify(blockedEvidence, null, 2), 'utf8');
    const wrongReference = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
      '--repository-evidence', evidencePath, '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(wrongReference.status, 0);
    assert.match(JSON.parse(wrongReference.stdout).diagnostics[0].message, /must not carry an execution artifact reference/);

    const strippedChecks = [
      { id: 'RC-1', kind: 'command', command: 'node --version', outcome: 'passed', exitCode: 0, evidence: 'v18' },
      { id: 'RC-2', kind: 'command', command: 'node --version', outcome: 'passed', exitCode: 0, evidence: 'v18' },
    ];
    const strippedReturn = structuredClone(readyReturn(packet, buildEvidence(fixture, packet, productHead, strippedChecks)));
    for (const check of strippedReturn.checks) delete check.executionEvidence;
    const { digest, ...unsigned } = strippedReturn;
    strippedReturn.digest = `sha256:agenticloop.role-return.v4:${canonicalSha256(unsigned)}`;
    writeFileSync(join(fixture.root, returnPath), JSON.stringify(strippedReturn, null, 2), 'utf8');
    writeFileSync(join(fixture.root, evidencePath), JSON.stringify(buildEvidence(fixture, packet, productHead, strippedChecks), null, 2), 'utf8');
    const strippedVerified = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
      '--repository-evidence', evidencePath, '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(strippedVerified.status, 0);
    assert.match(JSON.parse(strippedVerified.stdout).diagnostics[0].message, /executionEvidence|fields must equal/);
  });

  it('persists a blocked environment return as observation only, without CLI-bound assurance', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'blocked-return-observation', {
      requiredChecksText: '- [RC-1] command: `node --version`\n- [RC-2] command: `node --version`',
    });
    const packetPath = '.agenticloop/tmp/dispatch.json';
    const returnPath = '.agenticloop/tmp/return.json';
    const evidencePath = '.agenticloop/tmp/evidence.json';
    const options = { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const packet = prepareDispatch(fixture).packet;
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(packet), 'utf8');
    const productHead = await engineerStart(fixture, packetPath, options);
    const checks = [
      { id: 'RC-1', kind: 'command', command: 'node --version', outcome: 'not_run', exitCode: -1, evidence: 'environment blocked', executionEvidence: null },
      { id: 'RC-2', kind: 'command', command: 'node --version', outcome: 'not_run', exitCode: -1, evidence: 'environment blocked', executionEvidence: null },
    ];
    const evidence = buildEvidence(fixture, packet, productHead, checks);
    evidence.checks = evidence.checks.map(check => {
      const { executionEvidence, ...baseline } = check;
      return baseline;
    });
    const blockedReturn = createRoleReturn({
      producerRole: 'engineer', packet: { packetId: packet.packetId, digest: packet.digest },
      task: { backend: 'files', id: 'T-001', ...evidence.task }, worktree: evidence.worktree,
      branch: evidence.branch, productBaseHead: evidence.productBaseHead, productHead: evidence.productHead,
      workflowHead: evidence.workflowHead, candidateHead: null, productChangedPaths: evidence.productChangedPaths,
      workflowChangedPaths: evidence.workflowChangedPaths, checks, productAttribution: evidence.productAttribution,
      pr: evidence.pr, carrierLineage: evidence.carrierLineage,
      outcome: { kind: 'implementation_blocked', completion: false, authority: 'non_authoritative_role_outcome' },
      disposition: 'blocked',
      blocker: {
        category: 'environment', evidence: { kind: 'command_failure', detail: 'sandbox unavailable' },
        resumeOwner: 'engineer', resumeTransition: 'implementation_resume',
        resumePreconditions: { items: ['Restore the execution environment.'], justification: null },
      },
      freshness: { invalidatedBy: packet.freshness.invalidatedBy },
    });
    writeFileSync(join(fixture.root, returnPath), JSON.stringify(blockedReturn), 'utf8');
    writeFileSync(join(fixture.root, evidencePath), JSON.stringify(evidence), 'utf8');
    const verified = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
      '--repository-evidence', evidencePath, '--json', '--target', fixture.root,
    ], options);
    assertOk(verified);
    const recordName = readdirSync(join(fixture.root, '.agenticloop', 'returns', 'verifications'))[0];
    const persisted = JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'returns', 'verifications', recordName), 'utf8'));
    assert.equal(persisted.disposition, 'blocked');
    assert.equal(persisted.requiredCheckEvidenceAssurance, 'unverified');
  });

  it('refuses --repository-evidence combined with --from-current-repository', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'repository-evidence-mutex');
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'p.json'), '{}', 'utf8');
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'r.json'), '{}', 'utf8');
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'e.json'), '{}', 'utf8');
    const result = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', '.agenticloop/tmp/p.json', '--return', '.agenticloop/tmp/r.json',
      '--repository-evidence', '.agenticloop/tmp/e.json', '--from-current-repository',
      '--json', '--target', fixture.root,
    ], options);
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).errors.join('\n'), /exactly one of --repository-evidence/);
  });
  it('refuses --from-current-repository with a typed unsupported-backend error before any GitHub access', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'github-derived-refusal');
    writeFileSync(join(fixture.root, '.agenticloop', 'project.md'), [
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
    ].join('\n'), 'utf8');
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'p.json'), '{}', 'utf8');
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'r.json'), '{}', 'utf8');
    const before = fixtureGit(fixture.root, ['status', '--porcelain']);
    const ghCalls = [];
    const result = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', '.agenticloop/tmp/p.json', '--return', '.agenticloop/tmp/r.json',
      '--from-current-repository', '--json', '--target', fixture.root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
      ghCommandRunner: (...args) => { ghCalls.push(args); throw new Error('gh must not be invoked'); },
    });
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(JSON.parse(result.stdout).errors.join('\n'), /--from-current-repository is supported for the files backend only/);
    assert.deepEqual(ghCalls, []);
    assert.equal(fixtureGit(fixture.root, ['status', '--porcelain']), before);
  });

  it('persists and reuses a GitHub authenticated execution receipt from public CLI lifecycle inputs without rerunning or re-consuming it', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'github-authenticated-execution', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const issue = 42;
    const packetPath = '.agenticloop/tmp/github.packet.json';
    const checksPath = '.agenticloop/tmp/github.checks.json';
    const returnPath = '.agenticloop/tmp/github.return.json';
    const evidencePath = '.agenticloop/tmp/github.repository-evidence.json';
    const producerReceiptPath = '.agenticloop/tmp/github.producer-receipt.json';
    const executionReceiptPath = '.agenticloop/tmp/github.execution-receipt.json';
    let body = `${readFileSync(fixture.taskPath, 'utf8')
      .replace(/^backend: files$/m, 'backend: github')
      .replace(/^status: agent-ready$/m, 'status: draft')
      .replace(/\s*\[\[agent: [^\]]+\]\]\s*$/i, '')
      .trimEnd()}\n\n[[agent: maintainer]]\n`;
    const comments = [];
    const labels = ['receipt-fixture'];
    const state = {
      commandCalls: 0, replay: [], replayLedger: [], prHead: null, returnPrHead: null,
      prState: 'OPEN', issueState: null, closeoutOutput: null,
    };
    const prBody = () => [
      '## Scope Completed', 'Completed.', '',
      '## Artifacts', `Current implementation artifact: commit:${state.prHead}`, '',
      '## Evidence', `Current PR head: ${state.prHead}`, '',
      '- Required check: [RC-1] command: `node --version`',
      '  Verdict: passed', '  Evidence: node passed (exit 0)', '',
      '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.', '',
      '[[agent: engineer]]',
    ].join('\n');
    const comment = (text, id = comments.length + 1) => ({
      id,
      html_url: `https://example.test/comments/${id}`,
      user: { login: 'maintainer' },
      author_association: 'MEMBER',
      created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z', body: text,
    });
    const ghCommandRunner = (_command, args) => {
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'maintainer' }), stderr: '' };
      if (args[0] === 'api' && args.some(arg => String(arg).includes('/issues?state=all'))) return { status: 0, stdout: JSON.stringify([[{ number: issue, state: state.issueState ?? (state.prState === 'MERGED' ? 'CLOSED' : 'OPEN'), title: 'T-001 GitHub authenticated execution', body, labels }]]), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) {
        const endpoint = args.find(arg => /^repos\//.test(arg)) ?? '';
        return {
          status: 0,
          stdout: JSON.stringify(new RegExp(`issues/${issue}/comments`).test(endpoint) ? [comments] : [[]]),
          stderr: '',
        };
      }
      if (args[0] === 'issue' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ number: issue, state: state.issueState ?? (state.prState === 'MERGED' ? 'CLOSED' : 'OPEN'), title: 'T-001 GitHub authenticated execution', body, labels }]), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('closedByPullRequestsReferences')) {
        return { status: 0, stdout: JSON.stringify({ closedByPullRequestsReferences: [{ number: 7 }] }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('comments,updatedAt')) {
        return { status: 0, stdout: JSON.stringify({ comments, updatedAt: 'now' }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: issue, body }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'comment') {
        const commentBody = args.includes('--body-file')
          ? readFileSync(args[args.indexOf('--body-file') + 1], 'utf8')
          : args[args.indexOf('--body') + 1];
        comments.push(comment(commentBody));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
        body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const requestedFields = args[args.indexOf('--json') + 1] ?? '';
        if (requestedFields === 'headRefOid') return { status: 0, stdout: JSON.stringify({ headRefOid: state.prHead }), stderr: '' };
        return {
          status: 0,
          stdout: JSON.stringify({
            number: 7, state: state.prState, mergedAt: state.prState === 'MERGED' ? '2026-08-10T01:00:00Z' : null,
            mergeCommit: state.prState === 'MERGED' ? { oid: state.prHead } : null,
            reviewDecision: 'APPROVED', url: 'https://example.test/pull/7', body: prBody(),
            headRefOid: state.returnPrHead ?? state.prHead, headRefName: 'task/T-001', baseRefOid: packet?.repository?.baseHead,
            closingIssuesReferences: [{ number: issue }], closingIssuesReferences: [{ number: issue }], files: [{ path: 'src/existing.js' }],
            statusCheckRollup: [], comments: [], reviews: [],
            commits: state.prHead ? [{ oid: state.prHead, message: 'implement GitHub receipt return\n\nTask: T-001\nAgent: engineer' }] : [],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'api' && args.some(arg => String(arg).includes('/git/trees/'))) {
        return { status: 0, stdout: JSON.stringify({ tree: [{ path: 'src', type: 'tree' }] }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
    };
    const hostAuthority = protectedHostBoundary(fixture.trust, challenge => {
      if (challenge?.kind === 'agenticloop.execution-receipt-replay-boundary') {
        state.replay.push(challenge.operation);
        state.replayLedger.push({ operation: challenge.operation, binding: structuredClone(challenge.binding), transactionId: challenge.transactionId ?? null });
      }
    });
    const options = {
      ghCommandRunner,
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority,
      requiredCheckCommandRunner: call => {
        state.commandCalls += 1;
        assert.equal(call.command, 'node');
        assert.deepEqual(call.args, ['--version']);
        return { exitCode: 0, stdout: 'v-test\n', stderr: '' };
      },
    };
    const call = args => runCliInProcess(args, options);
    const currentBodyDigest = () => sha256(body);
    let base = fixtureGit(fixture.root, ['rev-parse', 'HEAD^{tree}']);
    let dependencies = 'dependencies.json';

    // A public GitHub carrier becomes a trusted lifecycle input through the
    // guarded baseline command; ordinary packet creation then reads it back.
    assertOk(await call([
      'task-body', 'establish-baseline', '--issue', String(issue), '--expect-digest', currentBodyDigest(),
      '--authority', 'policy:T-001', '--actor', 'maintainer', '--repo', 'example/repo', '--yes', '--json', '--target', fixture.root,
    ]));
    assert.equal(comments.length, 1);
    assertOk(await call([
      'task', 'prepare-decomposition', 'T-001', '--work-unit', 'milestone:M00',
      '--source-ref', '.agenticloop/decompositions/T-001.json', '--source-revision', 'fixture',
      '--base', base, '--dependencies', dependencies, '--json', '--target', fixture.root,
    ]));
    const decomposition = JSON.parse((await call([
      'task', 'prepare-decomposition', 'T-001', '--work-unit', 'milestone:M00',
      '--source-ref', '.agenticloop/decompositions/T-001.json', '--source-revision', 'fixture',
      '--base', base, '--dependencies', dependencies, '--json', '--target', fixture.root,
    ])).stdout);
    mkdirSync(join(fixture.root, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decomposition, null, 2), 'utf8');
    fixtureGit(fixture.root, ['add', '.agenticloop/decompositions']);
    fixtureGit(fixture.root, ['commit', '-m', 'record GitHub decomposition\n\nTask: T-001\nAgent: maintainer']);
    writeFileSync(join(fixture.root, '.agenticloop', 'project.md'), readFileSync(join(fixture.root, '.agenticloop', 'project.md'), 'utf8')
      .replace('task_backend: files', 'task_backend: github')
      .replace('work_unit_audit: enabled', 'work_unit_audit: disabled'), 'utf8');
    const githubDependencies = JSON.parse(readFileSync(join(fixture.root, 'dependencies.json'), 'utf8'));
    githubDependencies.observedAt = new Date().toISOString();
    const githubDependenciesPath = 'github-dependencies.json';
    writeFileSync(join(fixture.root, githubDependenciesPath), `${JSON.stringify(githubDependencies)}\n`, 'utf8');
    fixtureGit(fixture.root, ['add', '.agenticloop/project.md', githubDependenciesPath]);
    fixtureGit(fixture.root, ['commit', '-m', 'configure GitHub receipt fixture\n\nTask: #42\nAgent: maintainer']);
    base = fixtureGit(fixture.root, ['rev-parse', 'HEAD^{tree}']);
    const githubDecomposition = await call([
      'task', 'prepare-decomposition', 'T-001', '--work-unit', 'milestone:M00',
      '--source-ref', '.agenticloop/decompositions/T-001.json', '--source-revision', 'github-fixture',
      '--base', base, '--dependencies', dependencies, '--json', '--target', fixture.root,
    ]);
    assertOk(githubDecomposition);
    writeFileSync(join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json'), githubDecomposition.stdout, 'utf8');
    fixtureGit(fixture.root, ['add', '.agenticloop/decompositions/T-001.json']);
    fixtureGit(fixture.root, ['commit', '-m', 'record GitHub decomposition\n\nTask: T-001\nAgent: maintainer']);

    const ready = await call([
      'task-body', 'transition', '--issue', String(issue), '--status', 'agent-ready', '--expect-digest', currentBodyDigest(),
      '--base', base, '--dependencies', githubDependenciesPath, '--repo', 'example/repo', '--yes', '--json', '--target', fixture.root,
    ]);
    assertOk(ready);
    body = body.replace(/^status: draft$/m, 'status: agent-ready');
    base = fixtureGit(fixture.root, ['rev-parse', 'HEAD^{tree}']);
    const refreshedDecomposition = await call([
      'task', 'prepare-decomposition', 'T-001', '--work-unit', 'milestone:M00',
      '--source-ref', '.agenticloop/decompositions/T-001.json', '--source-revision', 'github-ready-fixture',
      '--base', base, '--dependencies', dependencies, '--json', '--target', fixture.root,
    ]);
    assertOk(refreshedDecomposition);
    writeFileSync(join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json'), refreshedDecomposition.stdout, 'utf8');
    fixtureGit(fixture.root, ['add', '.agenticloop/decompositions/T-001.json']);
    fixtureGit(fixture.root, ['commit', '-m', 'refresh GitHub ready decomposition\n\nTask: T-001\nAgent: maintainer']);

    const packetResult = await call([
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer', '--return-adapter', fixture.trust.adapterId,
      '--repo', 'example/repo', '--json', '--target', fixture.root,
    ]);
    assertOk(packetResult);
    const packet = JSON.parse(packetResult.stdout);
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(packet), 'utf8');
    body = body.replace(/^status: agent-ready$/m, 'status: in-progress');
    const start = await call([
      'task-body', 'transition', '--issue', String(issue), '--status', 'in-progress', '--expect-digest', currentBodyDigest(),
      '--dispatch-packet', packetPath, '--repo', 'example/repo', '--yes', '--json', '--target', fixture.root,
    ]);
    assertOk(start);

    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "github-authenticated";\n', 'utf8');
    fixtureGit(fixture.root, ['add', 'src/existing.js']);
    fixtureGit(fixture.root, ['commit', '-m', 'implement GitHub receipt return\n\nTask: T-001\nAgent: engineer']);
    const head = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    state.prHead = head;

    assertOk(await call([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath, '--output', checksPath,
      '--json', '--target', fixture.root,
    ]));
    assertOk(await call([
      'task', 'check-evidence-update', 'T-001', '--packet', packetPath, '--input', checksPath, '--output', checksPath,
      '--check', 'RC-1', '--outcome', 'passed', '--evidence', 'node passed',
      '--execution-output', '.agenticloop/tmp/RC-1.execution.json', '--json', '--target', fixture.root,
    ]));
    assert.equal(state.commandCalls, 1, 'only the public command execution step may run the required command');

    const execution = JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'tmp', 'RC-1.execution.json'), 'utf8'));
    const checks = JSON.parse(readFileSync(join(fixture.root, checksPath), 'utf8'));
    const repositoryChecks = checks.map(check => {
      const { executionEvidence, ...observation } = check;
      return observation;
    });
    const repositoryEvidence = {
      backend: 'github',
      task: {
        id: 'T-001', taskContractDigest: packet.task.taskContractDigest,
        dispatchCarrierDigest: packet.task.dispatchCarrierDigest, currentCarrierDigest: currentBodyDigest(),
      },
      worktree: packet.assignment.worktree, branch: 'task/T-001', productBaseHead: packet.repository.head,
      productHead: head, workflowHead: head, candidateHead: null,
      productChangedPaths: ['src/existing.js'], workflowChangedPaths: [],
      productAttribution: { range: { base: packet.repository.head, head }, commits: [head] },
      checks: repositoryChecks,
      carrierLineage: { dispatchConsumptionDigest: JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'handoffs', 'dispatch', 'T-001', readdirSync(join(fixture.root, '.agenticloop', 'handoffs', 'dispatch', 'T-001'))[0]), 'utf8')).digest, evidenceMutationReceiptDigests: [] },
      pr: { state: 'open', number: 7, url: 'https://example.test/pull/7' },
    };
    const returnTask = { backend: 'github', ...repositoryEvidence.task };
    const roleReturn = externalRoleReturn({
      returnId: 'return:00000000-0000-4000-8000-000000000073', producerRole: 'engineer',
      packet: { packetId: packet.packetId, digest: packet.digest }, task: returnTask,
      worktree: packet.assignment.worktree, branch: 'task/T-001', productBaseHead: packet.repository.head,
      productHead: head, workflowHead: head, candidateHead: null,
      productChangedPaths: ['src/existing.js'], workflowChangedPaths: [], checks,
      productAttribution: repositoryEvidence.productAttribution, pr: repositoryEvidence.pr,
      carrierLineage: repositoryEvidence.carrierLineage,
      outcome: { kind: 'implementation_ready_for_review', completion: false, authority: 'non_authoritative_role_outcome' },
      disposition: 'proceed', blocker: null,
      freshness: { invalidatedBy: ['task_or_contract_changes', 'packet_or_assignment_changes', 'branch_or_head_changes', 'check_or_transport_evidence_changes', 'initial_repository_state_changes'] },
    });
    const receipts = createAuthenticatedReturnReceipts(fixture.trust, {
      packet, roleReturn, repositoryEvidence,
      executions: [{
        checkId: 'RC-1', path: checks[0].executionEvidence.path, digest: execution.digest,
        logicalCommand: execution.check.command, args: execution.check.args,
        resolvedExecutable: execution.runner.resolvedExecutable, wrapperKind: execution.runner.wrapperKind,
        wrapperProgram: execution.runner.wrapperProgram, wrapperArgs: execution.runner.wrapperArgs,
        childExitCode: execution.execution.childExitCode,
      }],
      replayId: 'host-observation:github-authenticated-1',
    });
    writeFileSync(join(fixture.root, returnPath), JSON.stringify(roleReturn), 'utf8');
    writeFileSync(join(fixture.root, evidencePath), JSON.stringify(repositoryEvidence), 'utf8');
    writeFileSync(join(fixture.root, producerReceiptPath), JSON.stringify(receipts.producerReceipt), 'utf8');
    writeFileSync(join(fixture.root, executionReceiptPath), JSON.stringify(receipts.executionReceipt), 'utf8');

    const verifyArgs = [
      'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
      '--repository-evidence', evidencePath, '--producer-receipt', producerReceiptPath,
      '--execution-receipt', executionReceiptPath, '--repo', 'example/repo', '--json', '--target', fixture.root,
    ];
    assertOk(await call(verifyArgs));
    assert.equal(state.commandCalls, 1);
    assert.deepEqual(state.replay, ['prepare', 'commit']);
    const verificationFile = readdirSync(join(fixture.root, '.agenticloop', 'returns', 'verifications'))[0];
    const persisted = JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'returns', 'verifications', verificationFile), 'utf8'));
    assert.equal(persisted.backend, 'github');
    assert.equal(persisted.requiredCheckEvidenceAssurance, 'authenticated_receipt');

    const review = await call([
      'github-review-prepare', '--pr', '7', '--repo', 'example/repo', '--json', '--target', fixture.root,
    ]);
    assertOk(review);
    assert.equal(JSON.parse(review.stdout).handoffRecognition.recognized, true);
    assert.equal(state.commandCalls, 1, 'review preparation must reuse the persisted authenticated receipt');
    assert.deepEqual(state.replay.slice(0, 2), ['prepare', 'commit']);
    assert.ok(state.replay.slice(2).every(operation => operation === 'verify'));

    // These are deliberately public-command refusals.  Each starts from the
    // exact persisted record that the preceding review command accepted, then
    // breaks one external trust fact.  None may consume the receipt again or
    // mutate a GitHub carrier while refusing review entry.
    let verificationPath = join(fixture.root, '.agenticloop', 'returns', 'verifications', verificationFile);
    let persistedBytes = readFileSync(verificationPath, 'utf8');
    const reviewArgs = ['github-review-prepare', '--pr', '7', '--repo', 'example/repo', '--json', '--target', fixture.root];
    const closeoutOutputPath = join(fixture.root, '.agenticloop', 'tmp', 'github-closeout.json');
    const bytes = path => existsSync(path) ? readFileSync(path).toString('hex') : null;
    const refusedState = () => ({
      carrierBody: Buffer.from(body, 'utf8').toString('hex'),
      comments: Buffer.from(JSON.stringify(comments), 'utf8').toString('hex'),
      labels: Buffer.from(JSON.stringify(labels), 'utf8').toString('hex'),
      closeoutOutput: bytes(closeoutOutputPath),
      closeoutState: Buffer.from(JSON.stringify(state.closeoutOutput), 'utf8').toString('hex'),
      returnVerification: bytes(verificationPath),
      replayStore: state.replayLedger.filter(entry => entry.operation !== 'verify'),
    });
    const assertPublicRefusal = async (label, args, refusalOptions, expectedError) => {
      const before = refusedState();
      const replayLength = state.replay.length;
      const refusal = await runCliInProcess(args, refusalOptions);
      assert.notEqual(refusal.status, 0, `${label} must refuse at the public lifecycle boundary`);
      assert.match(`${refusal.stdout}\n${refusal.stderr}`, expectedError, `${label} must refuse for the revoked external context`);
      assert.deepEqual(refusedState(), before, `${label} must preserve every meaningful carrier, closeout, verification, and protected-store byte`);
      assert.deepEqual(state.replay.slice(0, 2), ['prepare', 'commit'], `${label} must not re-consume replay authority`);
      assert.ok(state.replay.slice(replayLength).every(operation => operation === 'verify'), `${label} may only verify replay state`);
    };
    await assertPublicRefusal('review: revoked adapter trust', reviewArgs, {
      ...options, operatorTrustRoot: join(fixture.root, '.agenticloop', 'missing-operator-trust'),
    }, /return adapter|host trust/i);
    const brokenReceipt = JSON.parse(persistedBytes);
    brokenReceipt.evidence.executionReceipt.authentication.signature = 'invalid-signature';
    brokenReceipt.digest = `sha256:agenticloop.return-verification.v4:${canonicalSha256(Object.fromEntries(Object.entries(brokenReceipt).filter(([key]) => key !== 'digest')))}`;
    writeFileSync(verificationPath, `${JSON.stringify(brokenReceipt, null, 2)}\n`, 'utf8');
    await assertPublicRefusal('review: invalid execution receipt signature', reviewArgs, options, /execution receipt|signature/i);
    writeFileSync(verificationPath, persistedBytes, 'utf8');
    await assertPublicRefusal('review: missing committed replay state', reviewArgs, {
      ...options, hostAuthority: protectedHostBoundary(fixture.trust),
    }, /replay/i);
    const executionPath = join(fixture.root, '.agenticloop', 'tmp', 'RC-1.execution.json');
    const executionBytes = readFileSync(executionPath, 'utf8');
    writeFileSync(executionPath, `${executionBytes}\nartifact content drift\n`, 'utf8');
    await assertPublicRefusal('review: execution artifact content and digest drift', reviewArgs, options, /execution evidence|digest|artifact/i);
    writeFileSync(executionPath, executionBytes, 'utf8');
    const accepted = await call([
      'task-body', 'transition', '--issue', String(issue), '--status', 'accepted', '--expect-digest', currentBodyDigest(),
      '--repo', 'example/repo', '--yes', '--json', '--target', fixture.root,
    ]);
    assertOk(accepted);
    const integrationArgs = [
      'task-body', 'set-field', '--issue', String(issue), '--field', 'integrated_by',
      '--value', `pr:7@${head}`, '--expect-digest', currentBodyDigest(),
      '--repo', 'example/repo', '--yes', '--json', '--target', fixture.root,
    ];
    await assertPublicRefusal('integration: revoked adapter trust', integrationArgs, {
      ...options, operatorTrustRoot: join(fixture.root, '.agenticloop', 'missing-operator-trust'),
    }, /return adapter|host trust/i);
    writeFileSync(verificationPath, `${JSON.stringify(brokenReceipt, null, 2)}\n`, 'utf8');
    await assertPublicRefusal('integration: invalid execution receipt signature', integrationArgs, options, /execution receipt|signature/i);
    writeFileSync(verificationPath, persistedBytes, 'utf8');
    await assertPublicRefusal('integration: missing committed replay state', integrationArgs, {
      ...options, hostAuthority: protectedHostBoundary(fixture.trust),
    }, /replay/i);
    const movedExecutionPath = join(fixture.root, '.agenticloop', 'tmp', 'RC-1.execution.moved.json');
    renameSync(executionPath, movedExecutionPath);
    await assertPublicRefusal('integration: execution artifact path drift', integrationArgs, options, /execution evidence|path|artifact/i);
    renameSync(movedExecutionPath, executionPath);
    assert.ok(readdirSync(join(fixture.root, '.agenticloop', 'handoffs', 'task-mutations', 'T-001'))
      .some(name => JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'handoffs', 'task-mutations', 'T-001', name), 'utf8')).mutationClass === 'acceptance_transition'),
    'the public acceptance transition must persist its carrier-lineage receipt');
    const integration = await call(integrationArgs);
    assertOk(integration);
    assert.equal(JSON.parse(integration.stdout).handoff_recognition.recognized, true);
    state.issueState = 'CLOSED';
    const closeoutArgs = [
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', `commit:${head}`, '--output', closeoutOutputPath, '--json', '--target', fixture.root,
    ];
    await assertPublicRefusal('closeout: revoked adapter trust', closeoutArgs, {
      ...options, operatorTrustRoot: join(fixture.root, '.agenticloop', 'missing-operator-trust'),
    }, /return adapter|host trust/i);
    writeFileSync(verificationPath, `${JSON.stringify(brokenReceipt, null, 2)}\n`, 'utf8');
    await assertPublicRefusal('closeout: invalid execution receipt signature', closeoutArgs, options, /execution receipt|signature/i);
    writeFileSync(verificationPath, persistedBytes, 'utf8');
    await assertPublicRefusal('closeout: missing committed replay state', closeoutArgs, {
      ...options, hostAuthority: protectedHostBoundary(fixture.trust),
    }, /replay/i);
    writeFileSync(executionPath, `${executionBytes}\ncloseout artifact digest drift\n`, 'utf8');
    await assertPublicRefusal('closeout: execution artifact digest drift', closeoutArgs, options, /execution evidence|digest|artifact/i);
    writeFileSync(executionPath, executionBytes, 'utf8');

    state.prState = 'CLOSED';
    await assertPublicRefusal('closeout: unmerged terminal PR', closeoutArgs, options, /not a merged terminal PR|not merged/i);
    state.prState = 'MERGED';
    state.returnPrHead = 'f'.repeat(40);
    await assertPublicRefusal('closeout: substituted merged PR head', closeoutArgs, options, /changed after return evidence/i);
    state.returnPrHead = null;

    const replayAuthority = createExecutionReceiptReplayAuthority({ target: fixture.root, trustedAdapter: fixture.trust.adapter, protectedBoundary: hostAuthority });
    const listed = listReturnVerifications(fixture.root, 'T-001', {
      taskContractDigest: packet.task.taskContractDigest,
      resolveTrustedAdapter: () => fixture.trust.adapter,
      resolveExecutionReceiptReplayAuthority: () => replayAuthority,
    });
    assert.equal(listed.ok, true, listed.errors.join('\n'));
    assert.equal(listed.records.length, 1);
    const revalidated = revalidateReturnVerification(persisted, {
      target: fixture.root, capabilities: fixture.trust.capabilities,
      resolveActivationBinding: () => ({ ok: true, errors: [] }), resolveTrustedAdapter: () => fixture.trust.adapter,
      executionReceiptReplayAuthority: replayAuthority, expectedBackend: 'github', expectedTaskId: 'T-001',
    });
    assert.equal(revalidated.ok, true, revalidated.errors.join('\n'));
    const closeout = await call(closeoutArgs);
    assertOk(closeout);
    state.closeoutOutput = JSON.parse(readFileSync(closeoutOutputPath, 'utf8'));
    assert.equal(state.closeoutOutput.completion_eligible, true);
    assertOk(await call([
      'closeout', 'record', '--packet', closeoutOutputPath, '--yes', '--repo', 'example/repo', '--json', '--target', fixture.root,
    ]));
    assert.match(body, /^status:\s*["']?closed["']?$/m);
    const retry = writeReturnVerification(fixture.root, persisted, {
      trustedAdapter: fixture.trust.adapter,
      executionReceiptReplayAuthority: replayAuthority,
    });
    assert.equal(retry.disposition, 'already_current');
    assert.equal(state.commandCalls, 1, 'verify/list/revalidation/recognition/retry must never rerun a command');
    assert.deepEqual(state.replay.slice(0, 2), ['prepare', 'commit'], 'only verification persistence may consume the execution receipt');
    assert.ok(state.replay.slice(2).every(operation => operation === 'verify'), 'review preparation, integration, and retry must only verify the committed replay binding');
  });

  it('refuses caller-created cancellation claims until a protected producer exists', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'cancellation-lifecycle', {
      requiredChecksText: '- [RC-1] command: `node --version`\n- [RC-2] command: `node --version`',
    });
    const packetPath = '.agenticloop/tmp/dispatch.json';
    const checksPath = '.agenticloop/tmp/checks.json';
    const cancelPath = '.agenticloop/tmp/cancellation.json';
    const returnPath = '.agenticloop/tmp/return.json';
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const packet = prepareDispatch(fixture).packet;
    writeFileSync(join(fixture.root, packetPath), JSON.stringify(packet), 'utf8');
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(fixture.root, 'T-001'),
      '--dispatch-packet', packetPath, '--json', '--target', fixture.root,
    ], options));
    fixtureGit(fixture.root, ['add', '.agenticloop/tasks', '.agenticloop/handoffs']);
    fixtureGit(fixture.root, ['commit', '-m', 'Start Engineer work\n\nTask: T-001\nAgent: engineer']);
    assertOk(await runCliInProcess([
      'task', 'check-evidence-init', 'T-001', '--packet', packetPath, '--output', checksPath,
      '--json', '--target', fixture.root,
    ], options));

    const invocationId = packet.assignment.invocationId;
    const requestId = 'cancellation-request:123e4567-e89b-12d3-a456-426614174001';
    const provenance = createCancellationProvenance({
      invocation: { controller: 'agenticloop', invocationId, command: 'node', args: ['agenticloop.js'] },
      request: { authority: 'agenticloop', requestId, invocationId, requestedAt: new Date(Date.now() - 1000).toISOString() },
      observation: { observer: 'agenticloop', requestId, invocationId, observedAt: new Date().toISOString(), state: 'observed' },
    });
    writeFileSync(join(fixture.root, cancelPath), JSON.stringify(provenance, null, 2), 'utf8');

    // A cancellation claim for another invocation cannot be produced, and nor
    // can one with the locally created lookalike for this invocation.
    const foreign = createCancellationProvenance({
      invocation: { controller: 'agenticloop', invocationId: 'invocation:123e4567-e89b-12d3-a456-426614174099', command: 'node', args: ['agenticloop.js'] },
      request: { authority: 'agenticloop', requestId, invocationId: 'invocation:123e4567-e89b-12d3-a456-426614174099', requestedAt: new Date(Date.now() - 1000).toISOString() },
      observation: { observer: 'agenticloop', requestId, invocationId: 'invocation:123e4567-e89b-12d3-a456-426614174099', observedAt: new Date().toISOString(), state: 'observed' },
    });
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'foreign.json'), JSON.stringify(foreign, null, 2), 'utf8');
    const wrongInvocation = await runCliInProcess([
      'task', 'prepare-return', 'T-001', '--packet', packetPath, '--check-evidence', checksPath,
      '--outcome', 'implementation_blocked', '--blocker-category', 'cancellation_requested',
      '--cancellation-evidence', '.agenticloop/tmp/foreign.json', '--output', returnPath,
      '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(wrongInvocation.status, 0);
    assert.match(JSON.parse(wrongInvocation.stdout).diagnostics[0].message, /positive cancellation authority is unavailable/);

    const produced = await runCliInProcess([
      'task', 'prepare-return', 'T-001', '--packet', packetPath, '--check-evidence', checksPath,
      '--outcome', 'implementation_blocked', '--blocker-category', 'cancellation_requested',
      '--cancellation-evidence', cancelPath, '--output', returnPath, '--json', '--target', fixture.root,
    ], options);
    assert.notEqual(produced.status, 0);
    assert.match(JSON.parse(produced.stdout).diagnostics[0].message, /positive cancellation authority is unavailable/);
    assert.equal(existsSync(join(fixture.root, returnPath)), false);
  });
});
