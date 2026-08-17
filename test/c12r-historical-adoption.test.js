/**
 * P35-C12R.7 (C12-F10): historical work reaches a truthful terminal state.
 *
 * T-016 and T-017 were implemented, accepted, integrated, and independently
 * auditable - and could not be closed. They predate dispatch packets and
 * verified returns, the `return_evidence_absent` waiver scope is retired, and a
 * mechanical gate cannot consume evidence that was never produced. A human
 * process exception was offered and recorded, and the gate still could not
 * accept it.
 *
 * Adoption is the third option, after re-waiving (which devalues normal
 * closeout for every task) and synthesizing (which is the one thing the model
 * exists to prevent). These cases pin the two properties that make it worth
 * having: it never invents the evidence it lacks, and it never passes for a
 * canonical closeout.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  HISTORICAL_ADOPTION_ASSURANCE,
  HISTORICAL_ADOPTION_KIND,
  HISTORICAL_ADOPTION_STATUS,
  HISTORICAL_MISSING_EVIDENCE_CLASSES,
  createHistoricalAdoption,
  historicalAdoptionRelativePath,
  projectHistoricalAdoption,
  validateHistoricalAdoption,
} from '../src/historical-adoption.js';
import { ACTIVATION_ASSURANCE_ORDER } from '../src/activation-grant.js';
import { KNOWN_TASK_STATUSES } from '../src/task-transition.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/git-fixture.js';
import { makePreflightTask } from './helpers/c12r-preflight-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-c12r-adoption-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

const COMMIT = 'a'.repeat(40);
const INTEGRATION_COMMIT = 'b'.repeat(40);

function adoptionInput(overrides = {}) {
  return {
    backend: 'files',
    taskId: 'T-016',
    repositoryIdentity: 'file:/tmp/fixture-repo',
    taskContractDigest: `sha256:v1:${'c'.repeat(64)}`,
    implementationArtifact: { kind: 'git_commit', commit: COMMIT },
    integration: { kind: 'git_merge', reference: 'main', commit: INTEGRATION_COMMIT },
    audit: { reference: 'audit:WU-1', auditedArtifact: COMMIT, independent: true },
    disposition: {
      kind: 'human_adoption',
      authority: 'operator:P35-C12R',
      reason: 'this task predates canonical dispatch and return evidence',
    },
    missingEvidence: ['dispatch_packet', 'verified_return'],
    adoptedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('P35-C12R.7 an adoption is visibly not a closeout', () => {
  it('carries a distinct terminal status and a reduced assurance grade', () => {
    const record = createHistoricalAdoption(adoptionInput());
    assert.equal(record.status, HISTORICAL_ADOPTION_STATUS);
    assert.equal(record.assurance, HISTORICAL_ADOPTION_ASSURANCE);
    // The reduced assurance is legible from the name alone, without consulting
    // a second record.
    assert.match(record.status, /historical/);
    // And it is not any canonical grade.
    assert.equal(ACTIVATION_ASSURANCE_ORDER.includes(record.assurance), false);
  });

  it('does not reuse a canonical lifecycle status', () => {
    // If adoption ever collapsed into `closed`, a reader scanning statuses
    // could no longer tell canonical closure from a reduced-assurance one.
    assert.equal(KNOWN_TASK_STATUSES.includes(HISTORICAL_ADOPTION_STATUS), false);
  });

  it('cannot select a stronger status or assurance', () => {
    for (const override of [{ status: 'closed' }, { assurance: 'operator_confirmed' }]) {
      const record = { ...createHistoricalAdoption(adoptionInput()), ...override };
      const checked = validateHistoricalAdoption(record);
      assert.equal(checked.ok, false, `${JSON.stringify(override)} must be refused`);
    }
  });

  it('projects the same reduced verdict for any backend', () => {
    // Files and GitHub must say the same thing about assurance, so the
    // projection is derived once rather than formatted twice.
    const files = projectHistoricalAdoption(createHistoricalAdoption(adoptionInput({ backend: 'files' })));
    const github = projectHistoricalAdoption(createHistoricalAdoption(adoptionInput({ backend: 'github' })));
    for (const key of ['status', 'assurance', 'canonicalClosure', 'reducedAssurance']) {
      assert.equal(files[key], github[key], `${key} must project identically across backends`);
    }
    assert.equal(files.canonicalClosure, false);
    assert.equal(files.reducedAssurance, true);
    assert.deepEqual([...files.missingEvidence], ['dispatch_packet', 'verified_return']);
  });
});

describe('P35-C12R.7 an adoption names what it lacks and invents nothing', () => {
  it('requires at least one declared missing evidence class', () => {
    assert.throws(
      () => createHistoricalAdoption(adoptionInput({ missingEvidence: [] })),
      /must name at least one missing evidence class/
    );
  });

  it('refuses an unrecognized evidence class', () => {
    assert.throws(
      () => createHistoricalAdoption(adoptionInput({ missingEvidence: ['made_up_class'] })),
      /unknown class/
    );
  });

  it('accepts every class in the closed domain', () => {
    const record = createHistoricalAdoption(adoptionInput({
      missingEvidence: [...HISTORICAL_MISSING_EVIDENCE_CLASSES],
    }));
    assert.deepEqual([...record.missingEvidence], [...HISTORICAL_MISSING_EVIDENCE_CLASSES].sort());
  });

  it('carries no packet, consumption, return, receipt, or activation field', () => {
    // The structural guarantee: there is nowhere in this schema to put
    // synthesized execution evidence, so none can be smuggled in.
    const record = createHistoricalAdoption(adoptionInput());
    const serialized = JSON.stringify(record);
    for (const forbidden of ['packetId', 'packetDigest', 'invocationId', 'consumedAt', 'returnReceipt', 'grantId']) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must never appear in an adoption record`);
    }
  });
});

describe('P35-C12R.7 an adoption binds current, exact, independently audited facts', () => {
  it('requires the exact current task contract', () => {
    const record = createHistoricalAdoption(adoptionInput());
    const checked = validateHistoricalAdoption(record, {
      taskContractDigest: `sha256:v1:${'d'.repeat(64)}`,
    });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /exact current task contract/);
  });

  it('requires the audit to name the exact artifact being adopted', () => {
    assert.throws(
      () => createHistoricalAdoption(adoptionInput({
        audit: { reference: 'audit:WU-1', auditedArtifact: 'e'.repeat(40), independent: true },
      })),
      /must name the exact artifact/
    );
  });

  it('refuses a non-independent audit', () => {
    assert.throws(
      () => createHistoricalAdoption(adoptionInput({
        audit: { reference: 'audit:WU-1', auditedArtifact: COMMIT, independent: false },
      })),
      /independent audit/
    );
  });

  it('requires a real integration identity, not a description', () => {
    for (const integration of [
      { kind: 'vibes', reference: 'main', commit: INTEGRATION_COMMIT },
      { kind: 'git_merge', reference: '', commit: INTEGRATION_COMMIT },
      { kind: 'git_merge', reference: 'main', commit: 'not-a-commit' },
    ]) {
      assert.throws(() => createHistoricalAdoption(adoptionInput({ integration })), /integration/);
    }
  });

  it('requires an explicit human disposition with a durable authority', () => {
    for (const disposition of [
      { kind: 'automatic', authority: 'operator:x', reason: 'a sufficiently long stated reason' },
      { kind: 'human_adoption', authority: 'not-a-reference', reason: 'a sufficiently long stated reason' },
      { kind: 'human_adoption', authority: 'operator:x', reason: 'too short' },
    ]) {
      assert.throws(() => createHistoricalAdoption(adoptionInput({ disposition })), /disposition/);
    }
  });

  it('freezes the record against any later edit', () => {
    const record = createHistoricalAdoption(adoptionInput());
    const tampered = { ...record, disposition: { ...record.disposition, authority: 'operator:someone-else' } };
    assert.equal(validateHistoricalAdoption(tampered).ok, false);
  });

  it('refuses a record bound to another task or repository', () => {
    const record = createHistoricalAdoption(adoptionInput());
    assert.equal(validateHistoricalAdoption(record, { taskId: 'T-999' }).ok, false);
    assert.equal(validateHistoricalAdoption(record, { repositoryIdentity: 'file:/elsewhere' }).ok, false);
  });
});

describe('P35-C12R.7 the CLI adopts only what genuinely predates the lifecycle', () => {
  function makeTarget(name, taskId) {
    const target = mkdtempSync(join(temp, `${name}-`));
    createTaskProjectFixture(target);
    makePreflightTask(target, taskId, { status: 'accepted' });
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', `task ${taskId}\n\nTask: ${taskId}\nAgent: maintainer`]);
    return target;
  }

  const args = (taskId, extra = []) => [
    'task', 'adopt-historical', taskId,
    '--artifact', COMMIT,
    '--integration', 'git_merge:main',
    '--integration-commit', INTEGRATION_COMMIT,
    '--audit', 'audit:WU-1',
    '--authority', 'operator:P35-C12R',
    '--reason', 'this task predates canonical dispatch and return evidence',
    '--missing', 'dispatch_packet',
    '--missing', 'verified_return',
    ...extra,
  ];

  it('writes a frozen adoption record for a historical task', async () => {
    const target = makeTarget('adopt-ok', 'T-016');
    const result = await runCliInProcess([...args('T-016'), '--json', '--target', target]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.projection.status, HISTORICAL_ADOPTION_STATUS);
    assert.equal(payload.projection.canonicalClosure, false);
    assert.deepEqual(payload.projection.missingEvidence, ['dispatch_packet', 'verified_return']);

    const written = JSON.parse(readFileSync(join(target, historicalAdoptionRelativePath('T-016')), 'utf8'));
    assert.equal(written.kind, HISTORICAL_ADOPTION_KIND);
    assert.equal(validateHistoricalAdoption(written, { taskId: 'T-016' }).ok, true);
  });

  it('states plainly that it created no execution evidence', async () => {
    const target = makeTarget('adopt-text', 'T-017');
    const result = await runCliInProcess([...args('T-017'), '--target', target]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /canonical closure:\s+no/);
    assert.match(result.stdout, /No dispatch, consumption, return, host receipt, or activation evidence was created/);
  });

  it('refuses a task that already entered the canonical lifecycle', async () => {
    // The laundering path this guard closes: a task with real dispatch
    // consumption must complete normal closeout, not be downgraded into a
    // reduced-assurance record.
    const target = makeTarget('adopt-canonical', 'T-018');
    const dispatchDir = join(target, '.agenticloop', 'handoffs', 'dispatch', 'T-018');
    mkdirSync(dispatchDir, { recursive: true });
    writeFileSync(join(dispatchDir, 'dispatch_placeholder.json'), '{"kind":"agenticloop.dispatch-consumption"}\n', 'utf8');
    const result = await runCliInProcess([...args('T-018'), '--target', target]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /canonical dispatch consumption evidence|dispatch consumption/i);
  });

  it('requires every input and names the recognized missing classes', async () => {
    const target = makeTarget('adopt-usage', 'T-019');
    const result = await runCliInProcess([
      'task', 'adopt-historical', 'T-019', '--artifact', COMMIT, '--target', target,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--missing/);
    for (const cls of HISTORICAL_MISSING_EVIDENCE_CLASSES) {
      assert.ok(result.stderr.includes(cls), `usage must name the ${cls} class`);
    }
  });

  it('refuses to adopt a task that is not present', async () => {
    const target = makeTarget('adopt-absent', 'T-020');
    const result = await runCliInProcess([...args('T-404'), '--target', target]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Task record not found/);
  });
});
