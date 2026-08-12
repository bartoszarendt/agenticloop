/** Referenced closeout improvement proposal tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCloseoutWorkflowDeltaFixture } from './helpers/closeout-workflow-delta-fixture.js';

const fixture = createCloseoutWorkflowDeltaFixture();
const { makeGitTarget, commitAll, closeout, certify } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

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
    const target = await makeGitTarget('improvement-valid');
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
    const target2 = await makeGitTarget('improvement-invalid');
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
    const target = await makeGitTarget('improvement-missing');
    const artifact = await certify(target);
    const missing = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--improvement-ref', 'I-2026-07-27-099', '--json',
    ], target);
    assert.equal(missing.status, 1);
    assert.ok(JSON.parse(missing.stdout).reasons.some(item => item.gate === 'improvement_refs'));

    // Valid proposal tied to unrelated tasks.
    const target2 = await makeGitTarget('improvement-foreign');
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
    const target = await makeGitTarget('improvement-unresolvable-source');
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
