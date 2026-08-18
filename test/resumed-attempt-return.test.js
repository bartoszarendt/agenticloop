/**
 * One route, not six mechanisms.
 *
 * The field run that followed the C12R remediation invoked `task
 * prepare-return` thirteen times and succeeded zero times, on a task whose
 * implementation was already committed and correct. Every mechanism it used
 * was covered by a green test. What no test covered was the *route*: a
 * repository with history, where the product work was committed under an
 * attempt that then had to be abandoned, and where the protocol's own recovery
 * steps - the abandonment receipt, the regenerated decomposition, the fresh
 * packet, the role-start carrier mutation - each add a workflow commit on top
 * of it.
 *
 * That sequence made two individually reasonable rules jointly unsatisfiable.
 * `task evidence` required `--product-head` to be exactly HEAD, so the
 * implementation artifact was rebound to a role-start workflow commit; the role
 * return then derived its product range from that commit, found nothing but
 * `.agenticloop/` paths, and refused for want of `productChangedPaths`. Every
 * recovery step widened the gap, and there was no exit.
 *
 * This drives the whole route through the real commands and requires it to end
 * in a verified return. Against the pre-remediation toolkit it fails twice: at
 * the evidence step, which would not accept a product head behind HEAD, and
 * then at the return. That is the point of keeping it at route level.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDispatchFixture, prepare as prepareDispatch } from './helpers/dispatch-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-resumed-return-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

/** Workflow state a role commits; scratch is deliberately never staged. */
const WORKFLOW_PATHS = [
  '.agenticloop/tasks',
  '.agenticloop/handoffs',
  '.agenticloop/decompositions',
];

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function commitWorkflow(root, subject, role) {
  git(root, ['add', ...WORKFLOW_PATHS]);
  git(root, ['commit', '-m', `${subject}\n\nTask: T-001\nAgent: ${role}`]);
}

function carrierDigest(root, taskId = 'T-001') {
  const content = readFileSync(join(root, '.agenticloop', 'tasks', `${taskId}.md`), 'utf8');
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

describe('a resumed attempt whose product work is already committed can return', () => {
  it('drives abandon, regenerate, remint, role start, evidence, and return to a verified return', async () => {
    const fixture = await createDispatchFixture(temp, 'resumed-return', {
      requiredChecksText: '- [RC-1] command: `node --version`\n- [RC-2] command: `node --version`',
    });
    const root = fixture.root;
    const cli = args => runCliInProcess([...args, '--target', root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    });
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });

    // ── attempt 1: role start, then real product work, committed ──────────
    const firstPacket = '.agenticloop/tmp/packet-1.json';
    writeFileSync(join(root, firstPacket), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');
    assertOk(await cli([
      'task', 'status', 'T-001', 'in-progress',
      '--expect-digest', carrierDigest(root), '--dispatch-packet', firstPacket, '--json',
    ]), 'first role start');
    commitWorkflow(root, 'start the engineer role', 'engineer');

    writeFileSync(join(root, 'src', 'existing.js'), 'export const current = "implemented";\n', 'utf8');
    git(root, ['add', 'src/existing.js']);
    git(root, ['commit', '-m', 'implement the task\n\nTask: T-001\nAgent: engineer']);
    const productHead = git(root, ['rev-parse', 'HEAD']);

    // ── attempt 1 dies. Its only legal exit writes a receipt that must itself
    //    be committed to pass the clean gate, moving HEAD past the product work.
    const attemptId = JSON.parse(assertOk(
      await cli(['task', 'attempt-status', 'T-001', '--json']), 'attempt status'
    ).stdout).attempts.at(-1).attemptId;
    assertOk(await cli([
      'task', 'abandon-attempt', 'T-001', '--attempt', attemptId,
      '--reason', 'the attempt window closed while the toolkit-mandated repairs were running',
      '--authority', 'operator:field-run', '--json',
    ]), 'abandon the expired attempt');
    commitWorkflow(root, 'abandon the expired attempt', 'maintainer');

    // ── the repairs preflight demands, each one another workflow commit ───
    const blocked = await cli([
      'task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json',
    ]);
    assert.equal(blocked.status, 1, 'the carrier drifted, so preflight refuses before a packet can be minted');
    const regenerate = JSON.parse(blocked.stdout).firstSafeRepair.replace(/^npx agenticloop /, '').split(' ');
    const regenerated = assertOk(await cli([...regenerate, '--json']), 'regenerate the decomposition');
    writeFileSync(join(root, '.agenticloop', 'decompositions', 'T-001.json'), regenerated.stdout, 'utf8');
    commitWorkflow(root, 'regenerate the decomposition', 'maintainer');
    assertOk(await cli(['task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json']), 'preflight after the repairs');

    // ── attempt 2 is minted on top of all of that ─────────────────────────
    const secondPacket = '.agenticloop/tmp/packet-2.json';
    assertOk(await cli([
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer',
      '--output', secondPacket, '--json',
    ]), 'mint a fresh packet');
    const packet = JSON.parse(readFileSync(join(root, secondPacket), 'utf8'));
    assert.equal(packet.repository.head, git(root, ['rev-parse', 'HEAD']));
    assert.notEqual(packet.repository.head, productHead, 'the fresh packet is based well past the product work');

    assertOk(await cli([
      'task', 'status', 'T-001', 'in-progress',
      '--expect-digest', carrierDigest(root), '--dispatch-packet', secondPacket,
      '--note', 'resuming the task under a fresh packet', '--json',
    ]), 'second role start');
    commitWorkflow(root, 'start the resumed engineer role', 'engineer');

    // ── the evidence chain, with a product head that is no longer HEAD ─────
    assert.notEqual(git(root, ['rev-parse', 'HEAD']), productHead, 'HEAD is past the product commits, exactly as in the field');
    assertOk(await cli([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', carrierDigest(root), '--product-head', productHead, '--json',
    ]), 'implementation artifact evidence bound to the real product head');
    assert.match(
      readFileSync(join(root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8'),
      new RegExp(`implementation_artifact: commit:${productHead}`),
      'the task record names the implementation, not the workflow commit that follows it'
    );
    commitWorkflow(root, 'record the implementation artifact', 'engineer');

    const checksPath = '.agenticloop/tmp/checks.json';
    assertOk(await cli([
      'task', 'check-evidence-init', 'T-001', '--packet', secondPacket, '--output', checksPath, '--json',
    ]), 'check evidence init');
    for (const check of JSON.parse(readFileSync(join(root, checksPath), 'utf8'))) {
      assertOk(await cli([
        'task', 'check-evidence-update', 'T-001', '--packet', secondPacket,
        '--input', checksPath, '--output', checksPath, '--check', check.id,
        '--outcome', 'passed', '--evidence', `${check.id} passed`,
        '--execution-output', `.agenticloop/tmp/${check.id}.execution.json`, '--json',
      ]), `check evidence update ${check.id}`);
    }

    // ── the step that was unreachable ─────────────────────────────────────
    const returnPath = '.agenticloop/tmp/return.json';
    assertOk(await cli([
      'task', 'prepare-return', 'T-001', '--packet', secondPacket, '--check-evidence', checksPath,
      '--outcome', 'implementation_ready_for_review', '--output', returnPath, '--json',
    ]), 'prepare-return on a resumed attempt');

    const roleReturn = JSON.parse(readFileSync(join(root, returnPath), 'utf8'));
    assert.equal(roleReturn.productHead, productHead);
    assert.deepEqual(roleReturn.productChangedPaths, ['src/existing.js'],
      'the carried product work is attributed as product work, not lost');
    assert.ok(roleReturn.productLineage, 'the return states the lineage it carries rather than widening silently');
    assert.deepEqual(roleReturn.productLineage.attempts.map(item => item.attemptId), [attemptId]);
    assert.equal(roleReturn.productBaseHead, roleReturn.productLineage.carriedBaseHead);
    assert.notEqual(roleReturn.productBaseHead, packet.repository.head);

    assertOk(await cli([
      'task', 'verify-return', 'T-001', '--packet', secondPacket, '--return', returnPath,
      '--from-current-repository', '--json',
    ]), 'verify-return on a resumed attempt');
  });

  it('refuses an implementation artifact that introduces no product work', async () => {
    // The durable half of the same defect: with the artifact pinned to HEAD,
    // T-018's record ended up naming a role-start workflow commit while the
    // implementation sat two commits earlier. Any later audit or closeout that
    // trusted the field would bind the wrong object.
    const fixture = await createDispatchFixture(temp, 'workflow-only-artifact');
    const root = fixture.root;
    const cli = args => runCliInProcess([...args, '--target', root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    });
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    const packetPath = '.agenticloop/tmp/packet.json';
    writeFileSync(join(root, packetPath), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');
    assertOk(await cli([
      'task', 'status', 'T-001', 'in-progress',
      '--expect-digest', carrierDigest(root), '--dispatch-packet', packetPath, '--json',
    ]), 'role start');
    commitWorkflow(root, 'start the engineer role', 'engineer');

    const workflowOnlyHead = git(root, ['rev-parse', 'HEAD']);
    const refused = await cli([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', carrierDigest(root), '--product-head', workflowOnlyHead, '--json',
    ]);
    assert.equal(refused.status, 1);
    assert.match(
      JSON.parse(refused.stdout).errors.join('\n'),
      /introduces at least one non-workflow path/
    );
  });
});
