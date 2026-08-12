import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createRoleReturn,
  dispatchPreparationDigest,
  receiveRoleReturn,
  validateDispatchPreparation,
} from '../src/dispatch-envelope.js';
import { createHostHandoffReceipt } from '../src/host-handoff.js';
import { createTaskReadinessEvidence } from '../src/task-evidence-contract.js';
import { generateOpencodeArtifacts } from '../src/adapters/opencode.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import {
  createDispatchFixture,
  git,
  prepare,
  producerBinding,
  readyReturn,
  repositoryEvidence,
  sha256,
} from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
let temp;

const currentFilesTask = name => createDispatchFixture(temp, name);

// Read-only tests share one fixture; tests that commit or write into the
// repository build their own.
let sharedTask;
const sharedFilesTask = () => (sharedTask ??= createDispatchFixture(temp, 'shared'));

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-dispatch-handoff-')); });
after(() => rmSync(temp, { recursive: true, force: true }));
describe('role-return handoff evidence', () => {
  it('accepts an unchanged raw producer return only with adapter provenance and repository evidence', async () => {
    const fixture = await currentFilesTask('return-positive');
    const prepared = prepare(fixture);
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'implement return\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(prepared.packet, { head: returnHead });
    evidence.productAttribution = {
      range: { base: prepared.packet.repository.head, head: returnHead },
      commits: git(fixture.root, ['rev-list', '--reverse', `${prepared.packet.repository.head}..${returnHead}`])
        .split(/\r?\n/)
        .filter(Boolean),
    };
    const roleReturn = readyReturn(prepared.packet, evidence);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence),
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
  });

  it('rejects recomputed packets whose material task contract binding differs from the authoritative task', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const mutations = [
      ['scope', value => `${value}\nattacker expansion`],
      ['allowedPaths', value => [...value, 'other/**']],
      ['activationCaptureRef', () => '.agenticloop/activation/other.json'],
      ['requiredChecks', value => value.map(check => check.id === 'RC-1' ? { ...check, command: 'npm run attacker' } : check)],
      ['taskContractDigest', () => `sha256:v1:${'f'.repeat(64)}`],
    ];
    for (const [field, mutate] of mutations) {
      const packet = structuredClone(prepared.packet);
      packet.task[field] = mutate(packet.task[field]);
      packet.digest = dispatchPreparationDigest(packet);
      assert.equal(validateDispatchPreparation(packet, fixture.options).ok, true, field);
      const evidence = repositoryEvidence(packet);
      const roleReturn = readyReturn(packet, evidence);
      const received = receiveRoleReturn({
        raw: JSON.stringify(roleReturn),
        packet,
        refetchTask: fixture.refetchTask,
        refetchRepositoryEvidence: () => evidence,
        ...producerBinding(fixture.trust, packet, roleReturn, evidence),
        runGit: fixture.runGit,
      }, fixture.options);
      assert.equal(received.ok, false, field);
      assert.equal(received.validation.producerRole, 'engineer', field);
      assert.match(received.validation.errors.join('\n'), /dispatch packet task contract/, field);
    }
  });

  it('rejects stale packet bytes when return and repository evidence are updated to the newer task', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const current = fixture.snapshot();
    const changedBody = `${current.body}\n`;
    const changed = { ...current, body: changedBody, digest: sha256(changedBody) };
    const evidence = repositoryEvidence(prepared.packet);
    evidence.task.currentCarrierDigest = changed.digest;
    const oldReturn = readyReturn(prepared.packet, evidence);
    const roleReturn = createRoleReturn({ ...oldReturn, task: { ...oldReturn.task, currentCarrierDigest: changed.digest }, digest: undefined });
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn),
      packet: prepared.packet,
      refetchTask: () => changed,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence),
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.equal(received.validation.producerRole, 'engineer');
    assert.match(received.validation.errors.join('\n'), /Git reader|required to rederive/, 'v3 files evidence requires a trusted Git reader');
  });

  it('rejects changed backend, task id, carrier, digest, and activation binding even with a recomputed packet digest', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const mutations = [
      packet => { packet.backend = 'github'; },
      packet => { packet.task.id = 'T-002'; },
      packet => { packet.task.carrier = 'issue:77'; },
      packet => { packet.task.dispatchCarrierDigest = sha256('different task bytes'); },
      packet => { packet.task.activationDigest = sha256('different activation'); },
    ];
    for (const mutate of mutations) {
      const packet = structuredClone(prepared.packet);
      mutate(packet);
      packet.digest = dispatchPreparationDigest(packet);
      const evidence = repositoryEvidence(packet);
      const candidate = readyReturn(packet, evidence);
      const received = receiveRoleReturn({
        raw: JSON.stringify(candidate),
        packet,
        refetchTask: fixture.refetchTask,
        refetchRepositoryEvidence: () => evidence,
        ...producerBinding(fixture.trust, packet, candidate, evidence),
      }, fixture.options);
      assert.equal(received.ok, false);
      assert.equal(received.validation.producerRole, 'engineer');
    }
  });

  it('rejects ready returns with non-zero passed checks, empty paths, empty attribution, or omitted repository evidence', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const variants = [
      { checks: [
        { id: 'RC-1', kind: 'command', command: 'npm test', outcome: 'passed', exitCode: 9, evidence: 'wrong' },
        { id: 'RC-2', kind: 'command', command: 'npm run typecheck', outcome: 'passed', exitCode: 0, evidence: 'ok' },
      ] },
      { productChangedPaths: [] },
    ];
    for (const patch of variants) {
      const candidate = { ...readyReturn(prepared.packet, repositoryEvidence(prepared.packet)), ...patch, digest: undefined };
      assert.throws(() => createRoleReturn(candidate), /invalid role return/);
    }
    const goodEvidence = repositoryEvidence(prepared.packet);
    const candidate = readyReturn(prepared.packet, goodEvidence);
    const missingEvidence = receiveRoleReturn({
      raw: JSON.stringify(candidate),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      ...producerBinding(fixture.trust, prepared.packet, candidate, goodEvidence),
    }, fixture.options);
    assert.equal(missingEvidence.ok, false);
    assert.equal(missingEvidence.validation.evidenceState, 'missing');
    const emptyAttribution = structuredClone(goodEvidence);
    emptyAttribution.productAttribution.commits = [];
    const malformed = { ...candidate, productAttribution: emptyAttribution.productAttribution };
    const received = receiveRoleReturn({
      raw: JSON.stringify(malformed),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => emptyAttribution,
      ...producerBinding(fixture.trust, prepared.packet, candidate, emptyAttribution),
    }, fixture.options);
    assert.equal(received.ok, false);
  });

  it('rejects replayed producer receipts across return identities and invocation bindings', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const evidence = repositoryEvidence(prepared.packet);
    const first = readyReturn(prepared.packet, evidence);
    const receipt = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      packet: prepared.packet,
      roleReturn: first,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: evidence,
    }, fixture.trust.privateKey);
    const second = readyReturn(prepared.packet, evidence);
    const replayed = receiveRoleReturn({
      raw: JSON.stringify(second),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      producerReceipt: receipt,
      resolveTrustedAdapter: () => fixture.trust.adapter,
    }, fixture.options);
    assert.equal(replayed.ok, false);
    assert.match(replayed.validation.errors.join('\n'), /authentication failed|does not bind/);
  });

  it('requires complete blocker and resumption facts', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const evidence = repositoryEvidence(prepared.packet);
    const invalid = {
      producerRole: 'engineer', packet: { packetId: prepared.packet.packetId, digest: prepared.packet.digest },
      task: {
        backend: 'files', id: 'T-001', taskContractDigest: prepared.packet.task.taskContractDigest,
        dispatchCarrierDigest: prepared.packet.task.dispatchCarrierDigest,
        currentCarrierDigest: prepared.packet.task.dispatchCarrierDigest,
      },
      worktree: evidence.worktree, branch: evidence.branch,
      productBaseHead: evidence.productBaseHead, productHead: evidence.productHead,
      workflowHead: evidence.workflowHead, candidateHead: null,
      productChangedPaths: [], workflowChangedPaths: [], checks: [
        { id: 'RC-1', kind: 'command', command: 'npm test', outcome: 'blocked', exitCode: 1, evidence: 'blocked' },
        { id: 'RC-2', kind: 'command', command: 'npm run typecheck', outcome: 'not_run', exitCode: -1, evidence: 'not run' },
      ],
      productAttribution: evidence.productAttribution,
      carrierLineage: {
        dispatchConsumptionDigest: `sha256:agenticloop.dispatch-consumption.v3:${'a'.repeat(64)}`,
        evidenceMutationReceiptDigests: [],
      },
      pr: evidence.pr,
      outcome: { kind: 'implementation_blocked', completion: false, authority: 'non_authoritative_role_outcome' }, disposition: 'blocked',
      blocker: { category: '', evidence: { kind: '', detail: '' }, resumeOwner: '', resumeTransition: '', resumePreconditions: { items: [], justification: '' } },
      freshness: {
        invalidatedBy: [
          'task_or_contract_changes', 'packet_or_assignment_changes', 'branch_or_head_changes',
          'check_or_transport_evidence_changes', 'initial_repository_state_changes',
        ],
      },
    };
    assert.throws(() => createRoleReturn(invalid), /category|blocker|resume/i);
  });

  it('rejects manually reconstructed orchestrator returns and exposes a read-only return verifier', async () => {
    const fixture = await currentFilesTask('manual-return');
    const prepared = prepare(fixture);
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'implement return\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(prepared.packet, { head: returnHead });
    evidence.productAttribution = {
      range: { base: prepared.packet.repository.head, head: returnHead },
      commits: git(fixture.root, ['rev-list', '--reverse', `${prepared.packet.repository.head}..${returnHead}`])
        .split(/\r?\n/)
        .filter(Boolean),
    };
    const roleReturn = readyReturn(prepared.packet, evidence);
    const manual = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence, { source: 'orchestrator' }),
    }, fixture.options);
    assert.equal(manual.ok, false);
    const packetPath = join(fixture.root, 'packet.json');
    const returnPath = join(fixture.root, 'return.json');
    writeFileSync(packetPath, JSON.stringify(prepared.packet), 'utf8');
    writeFileSync(returnPath, JSON.stringify(roleReturn), 'utf8');
    const run = await runCliInProcess(
      ['task', 'verify-return', 'T-001', '--packet', 'packet.json', '--return', 'return.json', '--host-trust-store', fixture.trustStorePath, '--json', '--target', fixture.root],
      { operatorTrustRoot: fixture.operatorTrustRoot }
    );
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.kind, 'agenticloop.validation-result');
    assert.equal(result.disposition, 'blocked');
    assert.match(result.errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
  });

  it('refetches an injected GitHub transport instead of swapping a projection object', async () => {
    const fixture = await sharedFilesTask();
    let calls = 0;
    const transport = {
      fetchIssue() {
        calls += 1;
        return { ...fixture.snapshot(), backend: 'github', carrier: 'issue:42' };
      },
    };
    const githubFixture = {
      ...fixture,
      refetchTask: () => transport.fetchIssue(),
      assignment: { ...fixture.assignment, canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/github.md'] },
      readiness: {
        ...fixture.readiness,
        evidence: createTaskReadinessEvidence({
          ...fixture.readiness.evidence,
          backend: 'github', task: { id: 'T-001', carrier: 'issue:42', expectedDigest: fixture.snapshot().digest },
        }),
      },
    };
    githubFixture.refetchReadiness = () => githubFixture.readiness;
    const prepared = prepare(githubFixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const githubEvidence = repositoryEvidence(prepared.packet, {
      pr: { state: 'open', number: 42, url: 'https://example.test/pull/42' },
    });
    const roleReturn = readyReturn(prepared.packet, githubEvidence);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: () => transport.fetchIssue(),
      refetchRepositoryEvidence: () => {
        calls += 1;
        return githubEvidence;
      },
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, githubEvidence),
    }, fixture.options);
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
    assert.ok(calls >= 3, 'injected transport must refetch GitHub issue and PR facts at dispatch and return');

    const attacked = structuredClone(prepared.packet);
    attacked.task.scope += '\nrecomputed GitHub packet expansion';
    attacked.digest = dispatchPreparationDigest(attacked);
    assert.equal(validateDispatchPreparation(attacked, fixture.options).ok, true);
    const attackedEvidence = repositoryEvidence(attacked, {
      pr: { state: 'open', number: 42, url: 'https://example.test/pull/42' },
    });
    const attackedReturn = readyReturn(attacked, attackedEvidence);
    const rejected = receiveRoleReturn({
      raw: JSON.stringify(attackedReturn),
      packet: attacked,
      refetchTask: () => transport.fetchIssue(),
      refetchRepositoryEvidence: () => attackedEvidence,
      ...producerBinding(fixture.trust, attacked, attackedReturn, attackedEvidence),
    }, fixture.options);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.validation.producerRole, 'engineer');
    assert.match(rejected.validation.errors.join('\n'), /dispatch packet task contract/);
  });
});

describe('OpenCode activation capability', () => {
  it('generates an explicit unsupported result instead of placeholder capture text', () => {
    const target = mkdtempSync(join(temp, 'opencode-target-'));
    const output = mkdtempSync(join(temp, 'opencode-output-'));
    mkdirSync(target, { recursive: true });
    seedTargetLayout(REPO_ROOT, target, { includeDocs: false, includeScratch: false });
    generateOpencodeArtifacts(loadAgenticLoopConfig(join(target, 'agenticloop.json')), target, output);
    const command = readFileSync(join(output, '.opencode', 'commands', 'agenticloop.md'), 'utf8');
    assert.match(command, /Activation capture capability: `unsupported`/);
    assert.doesNotMatch(command, /\$(?:ARGUMENTS|\d+)/);
    assert.match(command, /parser-owned byte artifact/);
  });
});
