/**
 * Public PR-body workflow tests: live-context lint, CLI-authored
 * snapshot round trip, legacy compatibility, diagnostic/ownership/exits, and
 * atomic output behavior — all through the public CLI with an injected
 * read-only GitHub command runner. No test performs a GitHub write.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliInProcess } from './helpers/run-cli.js';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const HEAD2 = 'f0e1d2c3b4a5968778695a4b3c2d1e0f0a9b8c7d';
const BASE = 'b'.repeat(40);
const ACCOUNT = { login: 'loop-bot', type: 'User' };
const REPO = 'octo/repo';

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-pr-body-workflow-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function workspace(name, { withReferences = false } = {}) {
  const dir = mkdtempSync(join(tmpDir, `${name}-`));
  if (withReferences) {
    mkdirSync(join(dir, '.agenticloop', 'decisions'), { recursive: true });
    mkdirSync(join(dir, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(dir, '.agenticloop', 'decisions', 'D-001.md'), '# D-001\n', 'utf8');
    writeFileSync(join(dir, '.agenticloop', 'tasks', 'T-007.md'), '# T-007\n', 'utf8');
    writeFileSync(join(dir, '.agenticloop', 'tasks', 'T-099.md'), '# T-099\n', 'utf8');
  }
  return dir;
}

function write(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

const STALE_REMOTE_BODY = 'stale remote draft: placeholder body that was never updated';

function issueBody() {
  return [
    '---', 'task_id: T-007', '---', '',
    '# T-007 Sample', '',
    '## Required Checks',
    '- [RC-1] `npm test`',
    '',
  ].join('\n');
}

function verificationAttempt({ number = 1, candidate = 'one_off', strategy = 'foreground', timeout = 180000, command = '`npm test`' } = {}) {
  return [
    `#### Attempt ${number}`, '',
    '- Artifact: commit:abc123',
    `- Command: ${command}`,
    `- Strategy: ${strategy}`,
    `- Timeout ms: ${timeout}`,
    '- Outcome: timed_out',
    `- Duration ms: ${timeout}`,
    '- Required: true',
    '- Partial evidence: test process exceeded the foreground host ceiling',
    '- Proposed next strategy: background',
    `- Candidate classification: ${candidate}`,
    '- Recorded by: engineer',
    '- Recorded at: 2026-07-17T12:00:00Z',
  ].join('\n');
}

function verificationTriage({ number = 1, classification = 'pending', reference = 'none' } = {}) {
  return [
    `#### Triage for attempt ${number}`, '',
    `- Classification: ${classification}`,
    `- Reference: ${reference}`,
    '- Triaged by: maintainer',
    '- Triaged at: 2026-07-17T12:30:00Z',
  ].join('\n');
}

function verificationComment(entries, checkId = 'RC-1') {
  return {
    body: [
      `<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:${checkId} -->`, '',
      '## Verification Attempts', '',
      `### ${checkId}`, '',
      entries.join('\n\n'), '',
      '[[agent: maintainer]]',
    ].join('\n'),
    author: ACCOUNT,
  };
}

function fixture(overrides = {}) {
  return {
    prData: {
      number: 7,
      body: STALE_REMOTE_BODY,
      baseRefOid: BASE,
      headRefOid: HEAD,
      files: [],
      closingIssuesReferences: [{ number: 3 }],
      statusCheckRollup: [],
      commits: [{ oid: HEAD, message: 'implement T-007\n\nTask: T-007\nAgent: engineer' }],
      comments: [],
      reviews: [],
    },
    issueData: { number: 3, title: 'T-007 sample', body: issueBody(), comments: [] },
    issueComments: [],
    repo: REPO,
    account: ACCOUNT,
    ...overrides,
  };
}

function referenceFixture() {
  return fixture({
    issueComments: [verificationComment([
      verificationAttempt({ number: 1 }),
      verificationTriage({ number: 1, classification: 'decision', reference: 'D-001' }),
      verificationAttempt({ number: 2, strategy: 'background', timeout: 300000 }),
      verificationTriage({ number: 2, classification: 'follow_up', reference: 'T-099' }),
    ])],
  });
}

/** Read-only fake `gh` runner; records every invocation. */
function createFakeGh(fx) {
  const invocations = [];
  const runner = (command, args) => {
    invocations.push([command, ...args]);
    const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    const fail = message => ({ status: 1, stdout: '', stderr: message });
    if (args[0] === 'pr' && args[1] === 'view') return json(fx.prData);
    if (args[0] === 'issue' && args[1] === 'view') return json(fx.issueData);
    if (args[0] === 'repo' && args[1] === 'view') return json({ nameWithOwner: fx.repo });
    if (args[0] === 'api') {
      if (args[1] === 'user') return json(fx.account);
      const endpoint = args.find(item => typeof item === 'string' && item.startsWith('repos/')) ?? '';
      if (endpoint.includes('/issues/') && endpoint.includes('/comments')) {
        const number = Number(endpoint.match(/issues\/(\d+)\/comments/)?.[1]);
        return json([number === fx.issueData.number ? fx.issueComments : []]);
      }
      if (endpoint.includes('/pulls/') && endpoint.includes('/reviews')) return json([[]]);
      if (endpoint.includes('/git/trees/')) return json({ tree: fx.baseTree ?? [], truncated: false });
      return fail(`unexpected endpoint ${endpoint}`);
    }
    return fail(`unexpected gh command: ${args.join(' ')}`);
  };
  return { invocations, runner };
}

function completeBody(head = HEAD) {
  return [
    '## Scope Completed', 'Completed the scoped change.', '',
    '## Artifacts', `Current implementation artifact: commit:${head}`, '',
    '## Evidence', `Current PR head: ${head}`, '',
    '- Required check: [RC-1] `npm test`', '  Verdict: passed', '  Evidence: 47 tests passed (exit 0)', '',
    '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.', '',
    '[[agent: engineer]]',
  ].join('\n');
}

function completeInput(body = completeBody()) {
  return {
    schemaVersion: 1,
    prData: { number: 42, body, headRefOid: HEAD, baseRefOid: BASE, files: [], statusCheckRollup: [], commits: [{ oid: HEAD, message: 'impl\n\nTask: T-007\nAgent: engineer' }], comments: [], reviews: [] },
    issueData: { number: 7, body: issueBody(), comments: [] },
    expectedAccount: ACCOUNT,
    reviewHistory: { events: [], errors: [] },
    basePaths: [], mode: 'review', pathInventoryRequired: false,
    projectFacts: [], references: { decisionIds: [], taskIds: [] },
    verificationStatus: null,
    configuration: { reviewBudget: 5, reviewBudgetError: null, projectMapConfig: null },
  };
}

function assertReadOnlyInvocations(invocations) {
  const allowedVerbs = new Set(['pr view', 'issue view', 'repo view']);
  const writeApiFlags = new Set(['--method', '-X', '--input', '--field', '-F', '--raw-field', '-f']);
  for (const invocation of invocations) {
    const args = invocation[0] === 'gh' ? invocation.slice(1) : invocation;
    const verb = `${args[0] ?? ''} ${args[1] ?? ''}`;
    if (args[0] === 'api') {
      assert.ok(!args.some(arg => writeApiFlags.has(arg)), `GitHub API write option invoked: ${invocation.join(' ')}`);
      continue;
    }
    assert.ok(allowedVerbs.has(verb), `non-read GitHub command invoked: ${invocation.join(' ')}`);
  }
}

describe('pr-body live lint (--pr --body-file)', () => {
  it('evaluates the local draft instead of the stale remote body and performs no GitHub write', async () => {
    const dir = workspace('live-override');
    const fx = fixture();
    const fake = createFakeGh(fx);
    const bodyFile = write(dir, 'body.md', completeBody());
    const result = await runCliInProcess(['pr-body', 'lint', '--pr', '7', '--body-file', bodyFile, '--json'], { cwd: dir, ghCommandRunner: fake.runner });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.contextMode, 'live');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.inputComplete, true);
    assert.equal(parsed.bodyLintEvaluated, true);
    assert.equal(parsed.gateEvaluated, true);
    assert.equal(parsed.lintReady, true);
    assert.equal(parsed.gatePassed, true);
    assert.equal(parsed.publicationReady, true);
    assert.equal(parsed.headRefOid, HEAD);
    assert.equal(parsed.baseRefOid, BASE);
    assert.equal(parsed.repository, REPO);
    assert.equal(parsed.pr, 7);
    assert.equal(parsed.issue, 3);
    assert.equal(parsed.mode, 'review');
    // The remote body is stale scaffold-free prose: if it had been evaluated,
    // the gate would report missing sections/evidence instead of passing.
    assert.ok(fake.invocations.length > 0, 'live mode must load GitHub context');
    assertReadOnlyInvocations(fake.invocations);
  });

  it('fails closed with re-scaffold guidance after head drift instead of rebinding markers', async () => {
    const dir = workspace('live-drift');
    const fx = fixture({ prData: { ...fixture().prData, headRefOid: HEAD2, commits: [{ oid: HEAD2, message: 'impl\n\nTask: T-007\nAgent: engineer' }] } });
    const fake = createFakeGh(fx);
    const bodyFile = write(dir, 'body.md', completeBody(HEAD));
    const result = await runCliInProcess(['pr-body', 'lint', '--pr', '7', '--body-file', bodyFile, '--json'], { cwd: dir, ghCommandRunner: fake.runner });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.publicationReady, false);
    assert.equal(parsed.lintReady, false);
    assert.match(parsed.firstSafeRepair, /re-scaffold against the current head/);
    assert.match(parsed.nextCommand, /^npx agenticloop pr-body scaffold --pr 7 --output /);
    assert.ok(parsed.nextCommand.includes('body.md'));
    assert.ok(parsed.errors.some(error => /stale|current-head marker/.test(error)), 'stale evidence stays visible');
    assert.ok(!/refresh|rebind/i.test(parsed.firstSafeRepair), 'no marker-only refresh guidance');
    assert.ok(parsed.diagnostics.every(item => item.owner), 'every merged diagnostic must have an actionable owner');
    const human = await runCliInProcess(['pr-body', 'lint', '--pr', '7', '--body-file', bodyFile], { cwd: dir, ghCommandRunner: fake.runner });
    assert.doesNotMatch(human.stdout + human.stderr, /-> undefined/);
  });

  it('fails before any network access when the body file is missing', async () => {
    const dir = workspace('live-missing-body');
    const fake = createFakeGh(fixture());
    const result = await runCliInProcess(['pr-body', 'lint', '--pr', '7', '--body-file', join(dir, 'absent.md'), '--json'], { cwd: dir, ghCommandRunner: fake.runner });
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.failureCategories, ['local_file']);
    assert.equal(parsed.bodyLintEvaluated, false);
    assert.equal(parsed.gateEvaluated, false);
    assert.equal(fake.invocations.length, 0, 'no GitHub read may run before the local body exists');
    assert.equal(parsed.diagnostics[0].owner, 'engineer');
  });

  it('rejects invalid option shapes with exit 2 before file or network access', async () => {
    const dir = workspace('live-usage');
    const fake = createFakeGh(fixture());
    const cases = [
      ['pr-body', 'lint', '--pr', '7'],
      ['pr-body', 'lint', '--pr', '7', '--snapshot', 'x.json', '--body-file', 'b.md'],
      ['pr-body', 'lint', '--input', 'x.json', '--body-file', 'b.md'],
      ['pr-body', 'lint', '--input', 'x.json', '--repo', REPO],
      ['pr-body', 'lint', '--input', 'x.json', '--issue', '3'],
      ['pr-body', 'lint', '--snapshot', 'x.json', '--body-file', 'b.md', '--repo', REPO],
      ['pr-body', 'lint', '--snapshot', 'x.json', '--body-file', 'b.md', '--issue', '3'],
      ['pr-body', 'lint', '--body-file', 'b.md'],
      ['pr-body', 'lint'],
    ];
    for (const args of cases) {
      const result = await runCliInProcess([...args, '--json'], { cwd: dir, ghCommandRunner: fake.runner });
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.failureCategories, ['usage'], args.join(' '));
    }
    assert.equal(fake.invocations.length, 0, 'usage failures must not touch GitHub');
  });
});

describe('pr-body scaffold with --snapshot-output', () => {
  it('writes body and snapshot atomically, creates missing parents, and reports both paths and the next command', async () => {
    const dir = workspace('scaffold-roundtrip', { withReferences: true });
    const fake = createFakeGh(fixture());
    const bodyPath = join('.agenticloop', 'tmp', 'T-007-pr-body.md');
    const snapshotPath = join('.agenticloop', 'tmp', 'T-007-pr-body.snapshot.json');
    const result = await runCliInProcess(
      ['pr-body', 'scaffold', '--pr', '7', '--output', bodyPath, '--snapshot-output', snapshotPath, '--json'],
      { cwd: dir, ghCommandRunner: fake.runner },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.lintReady, false);
    assert.equal(parsed.publicationReady, false);
    assert.ok(existsSync(join(dir, bodyPath)), 'body file must exist');
    assert.ok(existsSync(join(dir, snapshotPath)), 'snapshot file must exist');
    assert.equal(parsed.output, join(dir, bodyPath));
    assert.equal(parsed.snapshotOutput, join(dir, snapshotPath));
    assert.match(parsed.nextCommand, /^npx agenticloop pr-body lint --pr 7 --body-file /);
    assert.ok(parsed.nextCommand.includes(bodyPath));
    const snapshot = JSON.parse(readFileSync(join(dir, snapshotPath), 'utf8'));
    assert.equal(snapshot.kind, 'agenticloop.pr-body-context');
    assert.equal(snapshot.snapshotSchemaVersion, 1);
    assert.equal(snapshot.mode, 'review');
    assert.equal(snapshot.pr, 7);
    assert.equal(snapshot.issue, 3);
    assert.equal(snapshot.head, HEAD);
    assert.equal(snapshot.base, BASE);
    assert.equal(snapshot.repository, REPO);
    assert.ok(typeof snapshot.capturedAt === 'string' && snapshot.capturedAt.length > 0);
    assert.deepEqual(snapshot.input.references.decisionIds, ['D-001']);
    assert.deepEqual(snapshot.input.references.taskIds, ['T-007', 'T-099']);
    assert.equal(snapshot.input.prData.body, STALE_REMOTE_BODY, 'the snapshot records the remote body as context');
    assertReadOnlyInvocations(fake.invocations);
    assert.ok(!readdirSync(join(dir, '.agenticloop', 'tmp')).some(entry => entry.endsWith('.tmp')), 'no temporary residue');
  });

  it('prints both output paths and the exact next lint command in human output', async () => {
    const dir = workspace('scaffold-human');
    const fake = createFakeGh(fixture());
    const result = await runCliInProcess(
      ['pr-body', 'scaffold', '--pr', '7', '--output', 'body draft.md', '--snapshot-output', 'context snapshot.json'],
      { cwd: dir, ghCommandRunner: fake.runner },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Scaffold written to /);
    assert.match(result.stdout, /Snapshot written to /);
    assert.match(result.stdout, /Next command: npx agenticloop pr-body lint --pr 7 --body-file "body draft\.md"/);
    assert.match(result.stdout, /Offline lint: npx agenticloop pr-body lint --snapshot "context snapshot\.json" --body-file "body draft\.md"/);
    assert.match(result.stdout, /NOT publication-ready/);
  });

  it('reports a local_file failure and cleans up when the output path is not writable', async () => {
    const dir = workspace('scaffold-unwritable');
    writeFileSync(join(dir, 'blocking-file'), 'x', 'utf8');
    const fake = createFakeGh(fixture());
    const result = await runCliInProcess(
      ['pr-body', 'scaffold', '--pr', '7', '--output', join('blocking-file', 'body.md'), '--json'],
      { cwd: dir, ghCommandRunner: fake.runner },
    );
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.failureCategories, ['local_file']);
    assert.equal(parsed.diagnostics[0].owner, 'engineer');
    assert.ok(!readdirSync(dir).some(entry => entry.endsWith('.tmp')), 'failed atomic writes must clean up');
  });

  it('reports oversized inventories as snapshot_context before writing either output', async () => {
    const dir = workspace('scaffold-inventory-bound');
    const decisionsDir = join(dir, '.agenticloop', 'decisions');
    mkdirSync(decisionsDir, { recursive: true });
    for (let index = 0; index <= 1000; index += 1) {
      writeFileSync(join(decisionsDir, `D-${String(index).padStart(4, '0')}.md`), '', 'utf8');
    }
    const fake = createFakeGh(fixture());
    const bodyPath = join(dir, 'body.md');
    const snapshotPath = join(dir, 'context.json');
    const result = await runCliInProcess(
      ['pr-body', 'scaffold', '--pr', '7', '--output', bodyPath, '--snapshot-output', snapshotPath, '--json'],
      { cwd: dir, ghCommandRunner: fake.runner },
    );
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.failureCategories, ['snapshot_context']);
    assert.match(parsed.errors[0], /could not prepare snapshot context.*inventory exceeds the 1000-record snapshot bound/);
    assert.equal(existsSync(bodyPath), false, 'body output must not be written before snapshot preparation succeeds');
    assert.equal(existsSync(snapshotPath), false, 'invalid snapshot context must not create a snapshot');
    assertReadOnlyInvocations(fake.invocations);
  });
});

describe('pr-body offline snapshot lint', () => {
  async function scaffoldSnapshot(dir, fx) {
    const fake = createFakeGh(fx);
    const result = await runCliInProcess(
      ['pr-body', 'scaffold', '--pr', '7', '--output', 'body.md', '--snapshot-output', 'ctx.snapshot.json', '--json'],
      { cwd: dir, ghCommandRunner: fake.runner },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return { snapshotPath: join(dir, 'ctx.snapshot.json'), bodyPath: join(dir, 'body.md') };
  }

  it('round-trips: scaffold, edit Markdown, lint offline with zero network access', async () => {
    const dir = workspace('snapshot-roundtrip', { withReferences: true });
    const { snapshotPath, bodyPath } = await scaffoldSnapshot(dir, fixture());
    writeFileSync(bodyPath, completeBody(), 'utf8');
    // No ghCommandRunner is injected: any network attempt would fail the run.
    const result = await runCliInProcess(['pr-body', 'lint', '--snapshot', snapshotPath, '--body-file', bodyPath, '--json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.contextMode, 'snapshot');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.publicationReady, true);
    assert.equal(parsed.headRefOid, HEAD);
    assert.equal(parsed.repository, REPO);
    assert.ok(parsed.capturedAt, 'snapshot provenance must surface the capture time');
  });

  it('has live/snapshot parity with non-empty resolvable task and decision references', async () => {
    const dir = workspace('parity', { withReferences: true });
    const fx = referenceFixture();
    const { snapshotPath, bodyPath } = await scaffoldSnapshot(dir, fx);
    writeFileSync(bodyPath, completeBody(), 'utf8');
    const offline = await runCliInProcess(['pr-body', 'lint', '--snapshot', snapshotPath, '--body-file', bodyPath, '--json'], { cwd: dir });
    assert.equal(offline.status, 0, offline.stderr + offline.stdout);
    const liveFake = createFakeGh(fx);
    const live = await runCliInProcess(['pr-body', 'lint', '--pr', '7', '--body-file', bodyPath, '--json'], { cwd: dir, ghCommandRunner: liveFake.runner });
    assert.equal(live.status, 0, live.stderr + live.stdout);
    const offlineResult = JSON.parse(offline.stdout);
    const liveResult = JSON.parse(live.stdout);
    for (const field of ['ok', 'inputComplete', 'bodyLintEvaluated', 'gateEvaluated', 'lintReady', 'gatePassed', 'publicationReady']) {
      assert.equal(offlineResult[field], liveResult[field], `${field} must match between snapshot and live modes`);
    }
    assert.deepEqual(offlineResult.errors, liveResult.errors);
    assert.deepEqual(offlineResult.warnings, liveResult.warnings);
    assert.deepEqual(offlineResult.failureCategories, liveResult.failureCategories);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.deepEqual(snapshot.input.references, { decisionIds: ['D-001'], taskIds: ['T-007', 'T-099'] });
  });

  it('materializes task references from a supported nested task_file_template', async () => {
    const dir = workspace('nested-template');
    mkdirSync(join(dir, '.agenticloop', 'decisions'), { recursive: true });
    mkdirSync(join(dir, '.agenticloop', 'tasks', 'T-007'), { recursive: true });
    mkdirSync(join(dir, '.agenticloop', 'tasks', 'T-099'), { recursive: true });
    writeFileSync(join(dir, '.agenticloop', 'decisions', 'D-001.md'), '# D-001\n', 'utf8');
    writeFileSync(join(dir, '.agenticloop', 'tasks', 'T-007', 'record.md'), '# T-007\n', 'utf8');
    writeFileSync(join(dir, '.agenticloop', 'tasks', 'T-099', 'record.md'), '# T-099\n', 'utf8');
    writeFileSync(join(dir, '.agenticloop', 'project.md'), [
      '---',
      'task_file_template: .agenticloop/tasks/{taskId}/record.md',
      '---',
      '',
    ].join('\n'), 'utf8');

    const fx = referenceFixture();
    const { snapshotPath, bodyPath } = await scaffoldSnapshot(dir, fx);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.deepEqual(snapshot.input.references, { decisionIds: ['D-001'], taskIds: ['T-007', 'T-099'] });

    writeFileSync(bodyPath, completeBody(), 'utf8');
    const offline = await runCliInProcess(['pr-body', 'lint', '--snapshot', snapshotPath, '--body-file', bodyPath, '--json'], { cwd: dir });
    const liveFake = createFakeGh(fx);
    const live = await runCliInProcess(['pr-body', 'lint', '--pr', '7', '--body-file', bodyPath, '--json'], { cwd: dir, ghCommandRunner: liveFake.runner });
    assert.equal(offline.status, 0, offline.stderr + offline.stdout);
    assert.equal(live.status, 0, live.stderr + live.stdout);
    assert.equal(JSON.parse(offline.stdout).publicationReady, JSON.parse(live.stdout).publicationReady);
  });

  it('fails offline when the materialized inventory no longer resolves a cited decision', async () => {
    const dir = workspace('snapshot-inventory', { withReferences: true });
    const { snapshotPath, bodyPath } = await scaffoldSnapshot(dir, referenceFixture());
    writeFileSync(bodyPath, completeBody(), 'utf8');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    snapshot.input.references.decisionIds = [];
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
    const result = await runCliInProcess(['pr-body', 'lint', '--snapshot', snapshotPath, '--body-file', bodyPath, '--json'], { cwd: dir });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.errors.join('\n'), /missing decision 'D-001'/);
    assert.equal(parsed.gateEvaluated, true, 'the gate ran against complete context and failed semantically');
  });

  it('rejects a snapshot with the wrong kind or version', async () => {
    const dir = workspace('snapshot-wrong-kind');
    const bodyFile = write(dir, 'body.md', completeBody());
    for (const mutation of [
      snapshot => { snapshot.kind = 'agenticloop.other'; },
      snapshot => { snapshot.snapshotSchemaVersion = 99; },
    ]) {
      const { snapshotPath } = await (async () => {
        const fake = createFakeGh(fixture());
        await runCliInProcess(['pr-body', 'scaffold', '--pr', '7', '--output', 'b.md', '--snapshot-output', 's.json', '--json'], { cwd: dir, ghCommandRunner: fake.runner });
        return { snapshotPath: join(dir, 's.json') };
      })();
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      mutation(snapshot);
      writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');
      const result = await runCliInProcess(['pr-body', 'lint', '--snapshot', snapshotPath, '--body-file', bodyFile, '--json'], { cwd: dir });
      assert.equal(result.status, 1, result.stdout);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed.failureCategories, ['snapshot_context']);
      assert.equal(parsed.inputComplete, false);
      assert.equal(parsed.gateEvaluated, false);
      assert.equal(parsed.publicationReady, false);
      assert.equal(parsed.diagnostics[0].owner, 'engineer');
    }
  });

  it('rejects internally inconsistent snapshot provenance', async () => {
    const dir = workspace('snapshot-provenance');
    const fake = createFakeGh(fixture());
    await runCliInProcess(['pr-body', 'scaffold', '--pr', '7', '--output', 'b.md', '--snapshot-output', 's.json', '--json'], { cwd: dir, ghCommandRunner: fake.runner });
    const snapshotPath = join(dir, 's.json');
    const bodyFile = write(dir, 'body.md', completeBody());
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    snapshot.pr = 99;
    snapshot.input.prData.headRefOid = HEAD2;
    writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');
    const result = await runCliInProcess(['pr-body', 'lint', '--snapshot', snapshotPath, '--body-file', bodyFile, '--json'], { cwd: dir });
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.failureCategories, ['snapshot_context']);
    assert.match(parsed.errors.join('\n'), /disagrees/);
    assert.equal(parsed.gateEvaluated, false);
  });

  it('rejects malformed timestamp, repository, issue, and nested review-mode provenance', async () => {
    const dir = workspace('snapshot-strict-provenance');
    const fake = createFakeGh(fixture());
    await runCliInProcess(['pr-body', 'scaffold', '--pr', '7', '--output', 'b.md', '--snapshot-output', 'base.json', '--json'], { cwd: dir, ghCommandRunner: fake.runner });
    const base = JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8'));
    const bodyFile = write(dir, 'body.md', completeBody());
    const cases = [
      ['capturedAt', snapshot => { snapshot.capturedAt = 'not-a-date'; }, /UTC ISO timestamp/],
      ['repository', snapshot => { snapshot.repository = { owner: 'octo' }; }, /repository/],
      ['issue', snapshot => { snapshot.issue = null; }, /positive integer/],
      ['nested mode', snapshot => { snapshot.input.mode = 'authoring'; }, /nested input mode/],
    ];
    for (const [label, mutate, expected] of cases) {
      const snapshot = structuredClone(base);
      mutate(snapshot);
      const snapshotPath = write(dir, `${label.replace(' ', '-')}.json`, JSON.stringify(snapshot));
      const result = await runCliInProcess(['pr-body', 'lint', '--snapshot', snapshotPath, '--body-file', bodyFile, '--json'], { cwd: dir });
      assert.equal(result.status, 1, `${label}: ${result.stdout}`);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed.failureCategories, ['snapshot_context'], label);
      assert.match(parsed.errors.join('\n'), expected, label);
      assert.equal(parsed.gateEvaluated, false, label);
    }
  });

  it('rejects malformed snapshot JSON and missing snapshot files', async () => {
    const dir = workspace('snapshot-malformed');
    const bodyFile = write(dir, 'body.md', completeBody());
    const badJson = write(dir, 'bad.snapshot.json', '{ not json');
    const malformed = await runCliInProcess(['pr-body', 'lint', '--snapshot', badJson, '--body-file', bodyFile, '--json'], { cwd: dir });
    assert.equal(malformed.status, 1, malformed.stdout);
    assert.deepEqual(JSON.parse(malformed.stdout).failureCategories, ['input_format']);
    const missing = await runCliInProcess(['pr-body', 'lint', '--snapshot', join(dir, 'absent.json'), '--body-file', bodyFile, '--json'], { cwd: dir });
    assert.equal(missing.status, 1, missing.stdout);
    assert.deepEqual(JSON.parse(missing.stdout).failureCategories, ['local_file']);
  });
});

describe('pr-body lint legacy --input compatibility', () => {
  it('retains JSON semantics and emits structured deprecation', async () => {
    const dir = workspace('legacy-ok');
    const input = write(dir, 'input.json', JSON.stringify(completeInput()));
    const result = await runCliInProcess(['pr-body', 'lint', '--input', input, '--json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.contextMode, 'legacy');
    assert.equal(parsed.publicationReady, true);
    assert.deepEqual(parsed.failureCategories, [], 'warnings must not populate failureCategories on a passing result');
    assert.ok(parsed.warnings.some(warning => /deprecated/.test(warning)), 'warnings must carry the deprecation');
    const deprecation = parsed.warningDiagnostics.find(item => item.category === 'deprecation');
    assert.ok(deprecation, 'warningDiagnostics must carry the deprecation');
    assert.match(deprecation.message, /--body-file/);
    const human = await runCliInProcess(['pr-body', 'lint', '--input', input], { cwd: dir });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stderr + human.stdout, /deprecated/);
    assert.match(human.stdout, /supplied legacy serialized context; live state was not checked/);
    assert.doesNotMatch(human.stdout, /publication-ready against the live context head/);
  });

  it('rejects Markdown passed to --input with a targeted Engineer-owned error', async () => {
    const dir = workspace('legacy-markdown');
    const markdown = write(dir, 'body.md', completeBody());
    const result = await runCliInProcess(['pr-body', 'lint', '--input', markdown, '--json'], { cwd: dir });
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.failureCategories, ['input_format']);
    assert.equal(parsed.diagnostics[0].owner, 'engineer');
    assert.match(parsed.errors[0], /Markdown/);
    assert.match(parsed.errors[0], /--body-file/);
    assert.match(parsed.firstSafeRepair, /--body-file/);
    assert.equal(parsed.gateEvaluated, false);
    assert.equal(parsed.publicationReady, false);
  });

  it('rejects malformed JSON passed to --input as an Engineer-owned format error', async () => {
    const dir = workspace('legacy-malformed');
    const input = write(dir, 'input.json', '{ "schemaVersion": 1, broken');
    const result = await runCliInProcess(['pr-body', 'lint', '--input', input, '--json'], { cwd: dir });
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.failureCategories, ['input_format']);
    assert.equal(parsed.diagnostics[0].owner, 'engineer');
    assert.match(parsed.errors[0], /not valid JSON/);
  });

  it('reports a missing --input file as an Engineer-owned local_file failure', async () => {
    const dir = workspace('legacy-missing');
    const result = await runCliInProcess(['pr-body', 'lint', '--input', join(dir, 'absent.json'), '--json'], { cwd: dir });
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.failureCategories, ['local_file']);
    assert.equal(parsed.diagnostics[0].owner, 'engineer');
  });
});

describe('pr-body lint result phases and aggregation', () => {
  it('treats incomplete context as an unevaluated gate whose repair outranks body repair', async () => {
    const dir = workspace('phases-incomplete');
    const incomplete = completeInput('REPLACE: still scaffolded');
    delete incomplete.prData.baseRefOid;
    const input = write(dir, 'incomplete.json', JSON.stringify(incomplete));
    const result = await runCliInProcess(['pr-body', 'lint', '--input', input, '--json'], { cwd: dir });
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.inputComplete, false);
    assert.equal(parsed.bodyLintEvaluated, true, 'body lint still runs and stays visible');
    assert.equal(parsed.gateEvaluated, false, 'an incomplete input never masquerades as an evaluated gate');
    assert.equal(parsed.gatePassed, false);
    assert.equal(parsed.publicationReady, false);
    assert.ok(parsed.errors.some(error => /baseRefOid/.test(error)), 'context errors remain visible');
    assert.ok(parsed.errors.some(error => /placeholder/i.test(error)), 'body errors remain visible');
    assert.match(parsed.firstSafeRepair, /complete the serialized preparation input/, 'context repair outranks body repair');
    assert.ok(parsed.failureCategories.includes('preparation_input'));
    assert.ok(parsed.failureCategories.includes('pr_body'), 'categories derive from the merged diagnostic set');
  });

  it('unions warnings and warning diagnostics across structural, gate, and deprecation phases', async () => {
    const dir = workspace('phases-warnings');
    const blockedBody = completeBody().replace('  Verdict: passed', '  Verdict: blocked');
    const input = write(dir, 'warnings.json', JSON.stringify(completeInput(blockedBody)));
    const result = await runCliInProcess(['pr-body', 'lint', '--input', input, '--json'], { cwd: dir });
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.warnings.some(warning => /reports verdict 'blocked'/.test(warning)), 'structural warnings survive the merge');
    assert.ok(parsed.warnings.some(warning => /deprecated/.test(warning)), 'deprecation survives the merge');
    const categories = parsed.warningDiagnostics.map(item => item.category);
    assert.ok(categories.includes('pr_body'));
    assert.ok(categories.includes('deprecation'));
    assert.ok(!parsed.failureCategories.includes('pr_body'), 'warning-only categories must not be represented as failures');
    assert.ok(!parsed.failureCategories.includes('deprecation'), 'deprecation warning must not be represented as a failure');
    assert.equal(parsed.gateEvaluated, true);
    assert.equal(parsed.publicationReady, false);
  });

  it('keeps lint-ready structural success distinct from a failed semantic gate', async () => {
    const dir = workspace('phases-gate-fail');
    const drifted = completeInput();
    drifted.prData.headRefOid = HEAD2;
    const input = write(dir, 'drifted.json', JSON.stringify(drifted));
    const result = await runCliInProcess(['pr-body', 'lint', '--input', input, '--json'], { cwd: dir });
    assert.equal(result.status, 1, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gateEvaluated, true);
    assert.equal(parsed.gatePassed, false);
    assert.equal(parsed.publicationReady, false);
  });
});

describe('pr-body help', () => {
  it('exposes all three modes, constraints, provenance, exits, and next actions', async () => {
    const dir = workspace('help');
    for (const args of [['help', 'pr-body'], ['pr-body', 'scaffold', '--help'], ['pr-body', 'lint', '--help']]) {
      const result = await runCliInProcess(args, { cwd: dir });
      assert.equal(result.status, 0, args.join(' '));
      const text = result.stdout;
      assert.match(text, /--body-file/, args.join(' '));
      assert.match(text, /--snapshot/, args.join(' '));
      assert.match(text, /github-preflight/, args.join(' '));
    }
    const lint = await runCliInProcess(['pr-body', 'lint', '--help'], { cwd: dir });
    assert.match(lint.stdout, /--input/);
    assert.match(lint.stdout, /mutually exclusive/);
    assert.match(lint.stdout, /contextMode/);
    assert.match(lint.stdout, /Exit statuses/);
    assert.match(lint.stdout, /zero network access|no network access/i);
    const top = await runCliInProcess(['help', 'pr-body'], { cwd: dir });
    assert.match(top.stdout, /--input/);
    assert.match(top.stdout, /mutually exclusive/);
    assert.match(top.stdout, /contextMode/);
    assert.match(top.stdout, /Exit statuses/);
    const scaffold = await runCliInProcess(['pr-body', 'scaffold', '--help'], { cwd: dir });
    assert.match(scaffold.stdout, /--snapshot-output/);
    assert.match(scaffold.stdout, /final implementation push/);
    assert.match(scaffold.stdout, /atomically/);
  });
});
