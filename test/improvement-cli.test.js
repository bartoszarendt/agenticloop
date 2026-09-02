/**
 * Improvement proposal tests: serious-incident capture, high-risk gating,
 * collision safety, transactional creation, lint, and status.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliInProcess } from './helpers/run-cli.js';
import { createImprovementProposal, parseImprovementProposal } from '../src/improvement.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-improvement-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop'), { recursive: true });
  return target;
}

const MARKER_DIGEST = `sha256:${'d'.repeat(64)}`;

/**
 * Seed the durable artifacts proposals cite: one covered task carrying a
 * closeout marker and one audit record. References must resolve against live
 * backend state; a chat-only or nonexistent artifact is not durable.
 */
async function seedEvidence(target) {
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), [
    '---',
    'task_id: T-001',
    'status: closed',
    '---',
    '',
    '# T-001',
    '',
    '## Comments',
    '',
    'AGENT_CLOSEOUT_STATUS: complete',
    'AGENT_CLOSEOUT_SCHEMA: 3',
    'AGENT_CLOSEOUT_WORK_UNIT: milestone:M00',
    `AGENT_CLOSEOUT_ARTIFACT: commit:${'a'.repeat(40)}`,
    'AGENT_CLOSEOUT_TASKS: T-001',
    'AGENT_CLOSEOUT_AUDIT: AUD-001/run:1',
    'AGENT_CLOSEOUT_AUDIT_ASSURANCE: session_reported',
    'AGENT_CLOSEOUT_AUDIT_PRODUCER_AUTHENTICATED: false',
    'AGENT_CLOSEOUT_PREDECESSOR: none',
    'AGENT_CLOSEOUT_PLAN_SYNC: none',
    'AGENT_CLOSEOUT_IMPROVEMENTS: none',
    `AGENT_CLOSEOUT_GATE: ${MARKER_DIGEST}`,
    '',
  ].join('\n'), 'utf-8');
  const created = await runCliInProcess([
    'audit', 'new',
    '--work-unit', 'milestone:M00',
    '--covered-tasks', 'T-001',
    '--artifact', `commit:${'a'.repeat(40)}`,
    '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
    '--target', target,
  ]);
  assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
}

function run(args, target) {
  return runCliInProcess(['improvement', ...args, '--target', target]);
}

const IMPROVEMENTS_DIR = join('.agenticloop', 'improvements');

describe('improvement new', () => {
  it('creates one valid proposal for a directly evidenced serious gate bypass', async () => {
    const target = makeTarget('serious');
    await seedEvidence(target);
    const result = await run([
      'new',
      '--title', 'Mechanically enforce work-unit audit before closeout',
      '--source-ref', 'AUD-001',
      '--source-ref', MARKER_DIGEST,
      '--target-surface', 'core-methodology',
      '--target-path', 'agenticloop/skills/task-closeout/SKILL.md',
      '--risk-level', 'medium',
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const dir = join(target, IMPROVEMENTS_DIR);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const proposal = parseImprovementProposal(readFileSync(join(dir, files[0]), 'utf-8'));
    assert.equal(proposal.status, 'proposed');
    assert.deepEqual(proposal.sourceRefs, ['AUD-001', MARKER_DIGEST]);
    assert.equal(proposal.requiresChangeRequest, false);
    assert.equal((await run(['lint'], target)).status, 0);
  });

  it('rejects an unresolvable source reference before creating anything', async () => {
    const target = makeTarget('bad-ref');
    await seedEvidence(target);
    const result = await run([
      'new',
      '--title', 'Fabricated evidence',
      '--source-ref', 'not-a-real-artifact',
      '--target-surface', 'core-methodology',
      '--target-path', 'agenticloop/skills/task-closeout/SKILL.md',
      '--risk-level', 'medium',
    ], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not resolvable/);
    assert.equal(existsSync(join(target, IMPROVEMENTS_DIR)), false, 'failed creation leaves no directory residue');
  });

  it('rejects references to artifacts that do not exist', async () => {
    const target = makeTarget('missing-audit');
    await seedEvidence(target);
    const result = await run([
      'new',
      '--title', 'Missing audit',
      '--source-ref', 'AUD-099',
      '--target-surface', 'core-methodology',
      '--target-path', 'agenticloop/skills/task-closeout/SKILL.md',
      '--risk-level', 'medium',
    ], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AUD-099/);
    assert.equal(existsSync(join(target, IMPROVEMENTS_DIR)), false);
  });

  it('mechanically sets requires_change_request on high-risk proposals', async () => {
    const target = makeTarget('high-risk');
    await seedEvidence(target);
    const result = await run([
      'new',
      '--title', 'Replace the closeout gate',
      '--source-ref', 'AUD-001',
      '--target-surface', 'core-methodology',
      '--target-path', 'agenticloop/AGENTIC_LOOP.md',
      '--risk-level', 'high',
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const files = readdirSync(join(target, IMPROVEMENTS_DIR));
    const proposal = parseImprovementProposal(readFileSync(join(target, IMPROVEMENTS_DIR, files[0]), 'utf-8'));
    assert.equal(proposal.requiresChangeRequest, true);
    assert.equal((await run(['lint'], target)).status, 0);
  });

  it('requires durable evidence references; a chat-only claim is not durable', async () => {
    const target = makeTarget('no-refs');
    const result = await run([
      'new',
      '--title', 'Undocumented complaint',
      '--target-surface', 'skill-procedure',
      '--target-path', 'agenticloop/skills/x/SKILL.md',
      '--risk-level', 'low',
    ], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source-ref/);
    assert.equal(existsSync(join(target, IMPROVEMENTS_DIR)), false, 'failed creation leaves no directory residue');
  });

  it('allocates collision-safe ids without overwriting', async () => {
    const target = makeTarget('collisions');
    await seedEvidence(target);
    const args = [
      'new',
      '--title', 'One incident',
      '--source-ref', 'AUD-001',
      '--target-surface', 'skill-procedure',
      '--target-path', 'agenticloop/skills/x/SKILL.md',
      '--risk-level', 'low',
    ];
    assert.equal((await run(args, target)).status, 0);
    assert.equal((await run(args, target)).status, 0);
    const files = readdirSync(join(target, IMPROVEMENTS_DIR)).sort();
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1]);
    const first = parseImprovementProposal(readFileSync(join(target, IMPROVEMENTS_DIR, files[0]), 'utf-8'));
    const second = parseImprovementProposal(readFileSync(join(target, IMPROVEMENTS_DIR, files[1]), 'utf-8'));
    assert.equal(first.status, 'proposed');
    assert.equal(second.status, 'proposed');
  });

  it('does not overwrite an ID claimed between allocation and exclusive creation', () => {
    const target = makeTarget('injected-collision');
    const result = createImprovementProposal(target, {
      title: 'Racing proposal', sourceRefs: ['AUD-001'], targetSurface: 'skill-procedure',
      targetPath: 'agenticloop/skills/x/SKILL.md', riskLevel: 'low', date: '2026-07-27',
      beforeCreate: ({ relPath }) => {
        const file = join(target, relPath);
        mkdirSync(join(target, IMPROVEMENTS_DIR), { recursive: true });
        writeFileSync(file, 'existing proposal bytes\n', 'utf-8');
      },
    });
    assert.equal(result.ok, false);
    const dir = join(target, IMPROVEMENTS_DIR);
    assert.equal(readFileSync(join(dir, 'I-2026-07-27-001.md'), 'utf-8'), 'existing proposal bytes\n');
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  });

  it('rejects an invalid target surface before any write', async () => {
    const target = makeTarget('invalid-surface');
    await seedEvidence(target);
    const result = await run([
      'new',
      '--title', 'Bad surface',
      '--source-ref', 'AUD-001',
      '--target-surface', 'everything',
      '--target-path', 'agenticloop/AGENTIC_LOOP.md',
      '--risk-level', 'low',
    ], target);
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(target, IMPROVEMENTS_DIR)), false);
  });
});

describe('toolkit escalation export', () => {
  it('exports only the closed sanitized facts and requires explicit human confirmation', async () => {
    const target = makeTarget('toolkit-export');
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    const input = '.agenticloop/tmp/tooling-fact.json';
    const output = '.agenticloop/tmp/toolkit-proposal.json';
    writeFileSync(join(target, input), `${JSON.stringify({
      agenticLoopVersion: '0.4.7',
      command: 'npx agenticloop task readiness-apply C:\\private\\product',
      diagnosticCodes: ['readiness.candidate.internal_failure'],
      affectedSurface: 'src/readiness-candidates.js',
      sourceRefs: ['T-020'],
      reproduction: ['session ses_private failed with token=abc123supersecretvalue'],
    })}\n`, 'utf8');
    const refused = await run([
      'propose-toolkit-escalation', '--input', input,
      '--toolkit-repository', 'github:owner/agenticloop', '--output', output, '--json',
    ], target);
    assert.equal(refused.status, 2);
    assert.equal(existsSync(join(target, output)), false);
    const exported = await run([
      'propose-toolkit-escalation', '--input', input,
      '--toolkit-repository', 'github:owner/agenticloop', '--output', output, '--yes', '--json',
    ], target);
    assert.equal(exported.status, 0, `${exported.stdout}${exported.stderr}`);
    const proposal = JSON.parse(readFileSync(join(target, output), 'utf8'));
    assert.equal(proposal.transferAuthority, 'human_review_required');
    assert.equal(proposal.targetRepository.evidenceGrade, 'operator_asserted_external');
    assert.doesNotMatch(JSON.stringify(proposal), /ses_private|C:\\\\private|supersecretvalue/);
    assert.match(JSON.stringify(proposal), /redacted/);
  });

  it('rejects open-ended fields such as raw transcripts or private product content', async () => {
    const target = makeTarget('toolkit-forbidden');
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    const input = '.agenticloop/tmp/tooling-fact.json';
    writeFileSync(join(target, input), `${JSON.stringify({
      agenticLoopVersion: '0.4.7', command: 'cmd', diagnosticCodes: ['x'],
      affectedSurface: 'src/x.js', sourceRefs: ['T-020'], reproduction: ['step'],
      rawTranscript: 'private',
    })}\n`, 'utf8');
    const result = await run([
      'propose-toolkit-escalation', '--input', input,
      '--toolkit-repository', 'github:owner/agenticloop',
      '--output', '.agenticloop/tmp/out.json', '--yes', '--json',
    ], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden field/);
  });
});

describe('improvement lint and status', () => {
  it('lints a hand-corrupted proposal and reports the exact problem', async () => {
    const target = makeTarget('lint-corrupt');
    await seedEvidence(target);
    assert.equal((await run([
      'new',
      '--title', 'Valid proposal',
      '--source-ref', 'AUD-001',
      '--target-surface', 'skill-procedure',
      '--target-path', 'agenticloop/skills/x/SKILL.md',
      '--risk-level', 'low',
    ], target)).status, 0);
    const dir = join(target, IMPROVEMENTS_DIR);
    const [file] = readdirSync(dir);
    const content = readFileSync(join(dir, file), 'utf-8');
    const corrupted = content.replace('## Proposed change', '## Proposed Change');
    (await import('node:fs')).writeFileSync(join(dir, file), corrupted, 'utf-8');
    const lint = await run(['lint'], target);
    assert.equal(lint.status, 1);
    assert.match(lint.stdout, /## Proposed change/);
  });

  it('lists proposals with status and risk', async () => {
    const target = makeTarget('status');
    await seedEvidence(target);
    await run([
      'new',
      '--title', 'Listed',
      '--source-ref', 'AUD-001',
      '--target-surface', 'role-definition',
      '--target-path', 'agenticloop/agents/maintainer.md',
      '--risk-level', 'medium',
    ], target);
    const status = await run(['status', '--json'], target);
    assert.equal(status.status, 0);
    const entries = JSON.parse(status.stdout);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'proposed');
    assert.equal(entries[0].risk_level, 'medium');
  });
});
