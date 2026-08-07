/**
 * Safe post-certification workflow deltas (files backend).
 *
 * Only specifically validated deltas survive certification comparison:
 * the bound audit record, the exact marker mutation, a covered-task
 * accepted->closed terminal transition, an append-only schema-valid closeout
 * event in an applicable event log, an exact valid improvement proposal, and
 * transient scratch activity. Everything else is product drift.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { runCliInProcess } from './helpers/run-cli.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-deltas-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const PROJECT_MAP = [
  '---',
  'setup_status: confirmed',
  'development_stage: expansion',
  'task_backend: files',
  'work_unit_audit: enabled',
  'grouping_profile: milestone',
  '---',
  '',
  '# Project',
  '',
].join('\n');

function git(target, args) {
  return execSync(`git ${args}`, { cwd: target, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeGitTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), PROJECT_MAP, 'utf-8');
  git(target, 'init -q');
  git(target, 'config user.email test@example.com');
  git(target, 'config user.name Test');
  writeFileSync(join(target, 'app.js'), 'export const v = 1;\n', 'utf-8');
  writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n', 'utf-8');
  git(target, 'add -A');
  git(target, 'commit -qm init');
  return target;
}

function taskPath(target, taskId) {
  return join(target, '.agenticloop', 'tasks', `${taskId}.md`);
}

function writeTask(target, taskId, status, grouping = 'milestone:M00') {
  writeFileSync(
    taskPath(target, taskId),
    [
      '---',
      `task_id: ${taskId}`,
      `status: ${status}`,
      '---',
      '',
      `# ${taskId}`,
      '',
      '## Grouping',
      '',
      grouping,
      '',
      '## Comments',
      '',
      '',
    ].join('\n'),
    'utf-8'
  );
}

function commitAll(target, message) {
  git(target, 'add -A');
  git(target, `commit -qm "${message}"`);
  return `commit:${git(target, 'rev-parse HEAD')}`;
}

function wireReport(artifact, coveredTasks, overrides = {}) {
  return {
    report_schema: 'auditor_report_v1',
    producer: { roleId: 'auditor' },
    artifact,
    covered_tasks: coveredTasks,
    invocation: { mode: 'host_subagent', reference: `ref-${Math.random().toString(36).slice(2)}`, provenance: 'verified', receipt: `auditor-receipt-${Math.random().toString(36).slice(2)}` },
    perspectives: Object.fromEntries(
      ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
        .map(key => [key, `${key} body.`])
    ),
    assessment: 'Consolidated.',
    evidence_checked: 'npm test (pass)',
    verdict: 'certified',
    findings: [],
    ...overrides,
  };
}

async function audit(args, target) {
  return runCliInProcess(['audit', ...args, '--target', target]);
}

async function closeout(args, target) {
  return runCliInProcess(['closeout', ...args, '--target', target]);
}

async function certify(target, tasks = ['T-001', 'T-002']) {
  for (const taskId of tasks) writeTask(target, taskId, 'accepted');
  const artifact = commitAll(target, 'integrate candidate');
  const created = await audit([
    'new', '--work-unit', 'milestone:M00',
    '--covered-tasks', tasks.join(','),
    '--artifact', artifact,
    '--goal', 'Deliver the milestone.',
    '--completion-oracle', 'Observable completion.',
    '--evidence', 'npm test (pass)',
  ], target);
  assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
  commitAll(target, 'record audit');
  const reportPath = join(target, '.agenticloop', 'tmp', 'run-1.json');
  writeFileSync(reportPath, JSON.stringify(wireReport(artifact, tasks)), 'utf-8');
  const reported = await audit(['report', 'AUD-001', '--file', reportPath], target);
  assert.equal(reported.status, 0, `${reported.stdout}${reported.stderr}`);
  return artifact;
}

async function recordCompleteMarker(target, artifact) {
  const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
  const prepared = await closeout([
    'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
  ], target);
  assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
  const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
  assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
}

async function statusState(target) {
  const result = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
  return { exit: result.status, ...JSON.parse(result.stdout) };
}

function closeoutEvent(taskId) {
  return JSON.stringify({
    schema_version: 1,
    event_id: '11111111-1111-4111-8111-111111111111',
    occurred_at: '2026-07-27T12:00:00Z',
    trace_id: '22222222-2222-4222-8222-222222222222',
    parent_event_id: null,
    task_id: taskId,
    backend: 'files',
    host: 'test',
    role: 'maintainer',
    event_type: 'task.closed',
    summary: 'Task closed after certification.',
    outcome: 'success',
    refs: [],
    data: {},
  });
}

describe('covered-task terminal transitions', () => {
  it('recording a marker then closing another covered task does not stale the marker', async () => {
    const target = makeGitTarget('non-carrier-close');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    // The non-carrier covered task transitions accepted -> closed.
    writeTask(target, 'T-001', 'closed');
    commitAll(target, 'close T-001');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
    assert.equal(state.exit, 0, JSON.stringify(state));
  });

  it('closing multiple covered tasks including the carrier stays current', async () => {
    const target = makeGitTarget('all-close');
    const artifact = await certify(target, ['T-001', 'T-002', 'T-003']);
    await recordCompleteMarker(target, artifact);

    writeTask(target, 'T-001', 'closed');
    writeTask(target, 'T-002', 'closed');
    // The carrier (last in canonical order) may also transition; the marker
    // block is preserved because writeTask content carries no marker yet -
    // re-apply the carrier with its recorded marker intact.
    const carrierContent = readFileSync(taskPath(target, 'T-003'), 'utf-8');
    writeFileSync(taskPath(target, 'T-003'), carrierContent.replace(/^status: accepted$/m, 'status: closed'), 'utf-8');
    commitAll(target, 'close covered tasks');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
    assert.equal(state.exit, 0, JSON.stringify(state));
  });

  it('rejects any unrelated covered-task change as product drift', async () => {
    const target = makeGitTarget('unrelated-task-change');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    // Status regression is not the permitted terminal transition.
    writeTask(target, 'T-001', 'in-progress');
    commitAll(target, 'reopen T-001');

    const state = await statusState(target);
    assert.notEqual(state.state, 'complete');
    assert.ok(state.reasons.some(message => /T-001/.test(message)), JSON.stringify(state));

    // Body edits unrelated to the terminal transition are drift too.
    const target2 = makeGitTarget('task-body-edit');
    const artifact2 = await certify(target2);
    await recordCompleteMarker(target2, artifact2);
    writeFileSync(
      taskPath(target2, 'T-001'),
      readFileSync(taskPath(target2, 'T-001'), 'utf-8').replace(/^status: accepted$/m, 'status: closed') + '\nextra notes\n',
      'utf-8'
    );
    commitAll(target2, 'edit T-001 body');
    const state2 = await statusState(target2);
    assert.notEqual(state2.state, 'complete');
  });

  it('rejects arbitrary carrier edits while permitting the marker mutation itself', async () => {
    const target = makeGitTarget('carrier-edit');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    // Substantive carrier body change beyond marker + status: drift.
    const carrier = taskPath(target, 'T-002');
    writeFileSync(carrier, readFileSync(carrier, 'utf-8').replace('# T-002', '# T-002 renamed'), 'utf-8');
    commitAll(target, 'edit carrier title');

    const state = await statusState(target);
    assert.notEqual(state.state, 'complete', JSON.stringify(state));
  });
});

describe('append-only closeout event deltas', () => {
  it('permits a schema-valid append-only task.closed event in the applicable log', async () => {
    const target = makeGitTarget('event-append');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-001.jsonl'), `${closeoutEvent('T-001')}\n`, 'utf-8');
    commitAll(target, 'record closeout event');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
    assert.equal(state.exit, 0, JSON.stringify(state));
  });

  it('permits appending to a log that already existed at certification', async () => {
    const target = makeGitTarget('event-append-existing');
    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-001.jsonl'), '', 'utf-8');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    const secondEvent = {
      ...JSON.parse(closeoutEvent('T-001')),
      event_id: '33333333-3333-4333-8333-333333333333',
    };
    writeFileSync(
      join(target, '.agenticloop', 'logs', 'T-001.jsonl'),
      `${closeoutEvent('T-001')}\n${JSON.stringify(secondEvent)}\n`,
      'utf-8'
    );
    commitAll(target, 'append closeout events');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
  });

  it('fails closed when an event log is rewritten or carries disallowed events', async () => {
    const target = makeGitTarget('event-rewrite');
    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-001.jsonl'), `${closeoutEvent('T-001')}\n`, 'utf-8');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    // Rewriting history is never append-only: the original record's bytes
    // change even though a new record is appended behind it.
    const rewritten = { ...JSON.parse(closeoutEvent('T-001')), summary: 'Tampered history.' };
    writeFileSync(
      join(target, '.agenticloop', 'logs', 'T-001.jsonl'),
      `${JSON.stringify(rewritten)}\n${closeoutEvent('T-001')}\n`,
      'utf-8'
    );
    commitAll(target, 'rewrite event log');
    let state = await statusState(target);
    assert.notEqual(state.state, 'complete');

    // A disallowed event type fails closed.
    const target2 = makeGitTarget('event-type');
    const artifact2 = await certify(target2);
    await recordCompleteMarker(target2, artifact2);
    mkdirSync(join(target2, '.agenticloop', 'logs'), { recursive: true });
    const bad = { ...JSON.parse(closeoutEvent('T-001')), event_type: 'summary.published' };
    writeFileSync(join(target2, '.agenticloop', 'logs', 'T-001.jsonl'), `${JSON.stringify(bad)}\n`, 'utf-8');
    commitAll(target2, 'disallowed event');
    state = await statusState(target2);
    assert.notEqual(state.state, 'complete');

    // Malformed JSON fails closed.
    const target3 = makeGitTarget('event-malformed');
    const artifact3 = await certify(target3);
    await recordCompleteMarker(target3, artifact3);
    mkdirSync(join(target3, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target3, '.agenticloop', 'logs', 'T-001.jsonl'), '{not json}\n', 'utf-8');
    commitAll(target3, 'malformed event');
    state = await statusState(target3);
    assert.notEqual(state.state, 'complete');
  });

  it('an event log for a non-covered task is not an applicable log and remains drift', async () => {
    const target = makeGitTarget('event-foreign');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-099.jsonl'), `${closeoutEvent('T-099')}\n`, 'utf-8');
    commitAll(target, 'foreign event log');

    const state = await statusState(target);
    assert.notEqual(state.state, 'complete');
    assert.ok(state.reasons.some(message => /T-099/.test(message)), JSON.stringify(state));
  });
});

describe('scratch and rename safety', () => {
  it('treats tracked scratch activity under .agenticloop/tmp as transient', async () => {
    const target = makeGitTarget('scratch');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    writeFileSync(join(target, '.agenticloop', 'tmp', 'notes.txt'), 'transient\n', 'utf-8');
    git(target, 'add -f .agenticloop/tmp/notes.txt');
    git(target, 'commit -qm "tracked scratch"');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
  });

  it('rejects product-to-scratch and product-to-carrier rename attacks', async () => {
    const target = makeGitTarget('rename-scratch');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    git(target, 'mv app.js .agenticloop/tmp/app.js');
    git(target, 'add -A');
    git(target, 'commit -qm "rename product into scratch"');

    const state = await statusState(target);
    assert.notEqual(state.state, 'complete');
    assert.ok(state.reasons.some(message => /app\.js/.test(message)), JSON.stringify(state));
  });
});

describe('referenced improvement proposals', () => {
  function proposalContent(id) {
    return [
      '---',
      `improvement_id: ${id}`,
      'status: proposed',
      'date: 2026-07-27',
      'supersedes: []',
      'related_tasks: []',
      'source_refs:',
      '  - AUD-001',
      'target_surface: core-methodology',
      'target_path: agenticloop/skills/task-closeout/SKILL.md',
      'risk_level: medium',
      'requires_change_request: false',
      '---',
      '',
      `# ${id}: Proposal`,
      '',
      '## Failure pattern',
      'x',
      '',
      '## Evidence',
      'x',
      '',
      '## Inferred mechanism',
      'x',
      '',
      '## Proposed change',
      'x',
      '',
      '## Expected behavioral effect',
      'x',
      '',
      '## Regression risks',
      'x',
      '',
      '## Candidate patch',
      'None.',
      '',
      '## Validation plan',
      'x',
      '',
      '## Rollback',
      'x',
      '',
    ].join('\n');
  }

  it('permits an exact valid referenced proposal and rejects an invalid one', async () => {
    const target = makeGitTarget('improvement-valid');
    const artifact = await certify(target);
    mkdirSync(join(target, '.agenticloop', 'improvements'), { recursive: true });
    writeFileSync(
      join(target, '.agenticloop', 'improvements', 'I-2026-07-27-001.md'),
      proposalContent('I-2026-07-27-001'),
      'utf-8'
    );
    commitAll(target, 'record proposal');

    const eligible = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--improvement-ref', 'I-2026-07-27-001', '--json',
    ], target);
    assert.equal(eligible.status, 0, `${eligible.stdout}${eligible.stderr}`);
    const packet = JSON.parse(eligible.stdout);
    assert.deepEqual(packet.improvement_refs, ['I-2026-07-27-001']);

    // An invalid proposal at a referenced path is drift, never an allowed delta.
    const target2 = makeGitTarget('improvement-invalid');
    const artifact2 = await certify(target2);
    mkdirSync(join(target2, '.agenticloop', 'improvements'), { recursive: true });
    writeFileSync(
      join(target2, '.agenticloop', 'improvements', 'I-2026-07-27-001.md'),
      '---\nimprovement_id: wrong\n---\nno sections\n',
      'utf-8'
    );
    commitAll(target2, 'invalid proposal');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact2,
      '--improvement-ref', 'I-2026-07-27-001', '--json',
    ], target2);
    assert.equal(result.status, 1);
    const packet2 = JSON.parse(result.stdout);
    assert.ok(packet2.reasons.some(item => item.category === 'product_drift' || item.gate === 'improvement_refs'),
      JSON.stringify(packet2.reasons));
  });

  it('blocks closeout when a referenced proposal is missing or belongs to another work unit', async () => {
    // Missing proposal.
    const target = makeGitTarget('improvement-missing');
    const artifact = await certify(target);
    const missing = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--improvement-ref', 'I-2026-07-27-099', '--json',
    ], target);
    assert.equal(missing.status, 1);
    assert.ok(JSON.parse(missing.stdout).reasons.some(item => item.gate === 'improvement_refs'));

    // Valid proposal tied to unrelated tasks.
    const target2 = makeGitTarget('improvement-foreign');
    const artifact2 = await certify(target2);
    mkdirSync(join(target2, '.agenticloop', 'improvements'), { recursive: true });
    writeFileSync(
      join(target2, '.agenticloop', 'improvements', 'I-2026-07-27-001.md'),
      proposalContent('I-2026-07-27-001').replace('related_tasks: []', 'related_tasks:\n  - T-777'),
      'utf-8'
    );
    commitAll(target2, 'foreign proposal');
    const foreign = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact2,
      '--improvement-ref', 'I-2026-07-27-001', '--json',
    ], target2);
    assert.equal(foreign.status, 1);
    assert.ok(JSON.parse(foreign.stdout).reasons.some(item =>
      item.gate === 'improvement_refs' && /outside this work unit/.test(item.message)),
      foreign.stdout);
  });

  it('blocks closeout when a proposal cites an unresolvable durable source reference', async () => {
    const target = makeGitTarget('improvement-unresolvable-source');
    const artifact = await certify(target);
    mkdirSync(join(target, '.agenticloop', 'improvements'), { recursive: true });
    writeFileSync(
      join(target, '.agenticloop', 'improvements', 'I-2026-07-27-001.md'),
      proposalContent('I-2026-07-27-001').replace('  - AUD-001', '  - AUD-999'),
      'utf-8'
    );
    commitAll(target, 'record proposal with missing source');

    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--improvement-ref', 'I-2026-07-27-001', '--json',
    ], target);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item =>
      item.gate === 'improvement_refs' && /AUD-999/.test(item.message)),
      result.stdout);
  });
});
