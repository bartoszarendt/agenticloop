import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliInProcess } from './helpers/run-cli.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';

let tmpDir;

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
  it('creates, lists, lints, and updates a files-backed task', async () => {
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
    assertOk(status2);
    const content = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    assert.match(content, /^status: in-progress$/m);
    assert.match(content, /Started implementation/);
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

    git(target, ['init', '-q', '-b', 'main']);
    git(target, ['config', 'user.email', 'agenticloop@example.invalid']);
    git(target, ['config', 'user.name', 'Agentic Loop Test']);
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
    const original = readFileSync(path, 'utf-8').replace(
      '## Outcome\n',
      '## Outcome\n\n```md\n## Comments\nexample only\n```\n'
    );
    writeFileSync(path, original, 'utf-8');

    const result = await run(['task', 'status', 'T-001', 'closed', '--expect-digest', currentDigest(target, 'T-001'), '--note', 'Live note', '--target', target]);
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
      'verify-return': ['files'],
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

  it('allows agent-ready -> in-progress', async () => {
    const target = makeTarget('trans-ar-ip');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    await establishBaseline(target);
    assertOk(await run(['task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentDigest(target, 'T-001'), '--base', baseTree(target), '--dependencies', dependencySnapshot(target), '--target', target]));
    const result = await run(['task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(target, 'T-001'), '--note', 'Starting', '--target', target]);
    assertOk(result);
  });

  it('allows in-progress -> accepted with proper evidence', async () => {
    const target = makeTarget('trans-ip-ac');
    assertOk(await run(['task', 'new', 'Test', '--scaffold', '--target', target]));
    await establishBaseline(target);
    assertOk(await run(['task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentDigest(target, 'T-001'), '--base', baseTree(target), '--dependencies', dependencySnapshot(target), '--target', target]));
    assertOk(await run(['task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]));

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
    assertOk(result);
  });

  it('rejects accepted -> in-progress (terminal without reopen)', async () => {
    const target = makeTarget('trans-ac-ip');
    writeAcceptedTask(target, 'T-001');
    const result = await run(['task', 'status', 'T-001', 'in-progress', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot transition from 'accepted' to 'in-progress'/);
  });

  it('allows accepted -> closed', async () => {
    const target = makeTarget('trans-ac-cl');
    writeAcceptedTask(target, 'T-001');
    // accepted -> closed revalidates acceptance gate: review_status must be 'accepted'
    let content = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    content = content.replace('review_status: needs_revision', 'review_status: accepted');
    writeFileSync(taskPath(target, 'T-001'), content, 'utf-8');
    const result = await run(['task', 'status', 'T-001', 'closed', '--expect-digest', currentDigest(target, 'T-001'), '--target', target]);
    assertOk(result);
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
