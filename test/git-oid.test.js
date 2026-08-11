import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  GIT_OBJECT_ID_RE,
  gitObjectFormat,
  gitTreeObjectId,
  isGitObjectId,
  sameGitObjectFormat,
} from '../src/git-oid.js';
import { deriveCommitRange } from '../src/commit-range.js';
import {
  dispatchPreparationDigest,
  prepareRoleDispatch,
  receiveRoleReturn,
  validateDispatchPreparation,
  validateRoleReturn,
} from '../src/dispatch-envelope.js';
import { createTaskReadinessEvidence } from '../src/task-evidence-contract.js';
import {
  createDispatchFixture,
  producerBinding,
  readyReturn,
  repositoryEvidence,
} from './helpers/dispatch-fixture.js';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-git-oid-')); });
after(() => rmSync(temp, { recursive: true, force: true }));

function sha256RepoSupported() {
  const probe = mkdtempSync(join(temp, 'probe-'));
  const result = spawnSync('git', ['init', '--object-format=sha256'], { cwd: probe, encoding: 'utf8' });
  return result.status === 0;
}

describe('shared Git object identity rule', () => {
  it('accepts only full lowercase 40- or 64-character identities', () => {
    assert.equal(isGitObjectId(SHA1), true);
    assert.equal(isGitObjectId(SHA256), true);
    for (const value of [
      'a'.repeat(39), 'a'.repeat(41), 'b'.repeat(63), 'b'.repeat(65),
      'A'.repeat(40), 'abc1234', SHA1.slice(0, 7), `${SHA1} `,
      '', null, undefined, 42, `${SHA1}..${SHA1}`,
    ]) {
      assert.equal(isGitObjectId(value), false, JSON.stringify(value));
    }
  });

  it('is the single pattern every in-scope module consumes', () => {
    assert.equal(GIT_OBJECT_ID_RE.test(SHA1), true);
    assert.equal(GIT_OBJECT_ID_RE.test(SHA256), true);
    assert.equal(gitTreeObjectId(`git-tree:${SHA1}`), SHA1);
    assert.equal(gitTreeObjectId(`git-tree:${SHA256}`), SHA256);
    assert.equal(gitTreeObjectId(`git-tree:${SHA1.slice(0, 7)}`), null);
    assert.equal(gitTreeObjectId(SHA1), null);
  });

  it('rejects abbreviated and mixed-length commit ranges', () => {
    const runGit = () => ({ status: 0, stdout: '' });
    for (const [base, head] of [
      [SHA1.slice(0, 7), SHA1],
      [SHA1, SHA1.slice(0, 7)],
      [SHA1, SHA256],
      [SHA256, SHA1],
    ]) {
      const derived = deriveCommitRange({ runGit, baseHead: base, head, requireAttribution: false });
      assert.equal(derived.ok, false, `${base}..${head}`);
      assert.equal(derived.evidenceState, 'malformed');
    }
  });

  it('accepts full SHA-256 identities in role-return wire validation', () => {
    const packet = {
      backend: 'files',
      packetId: 'dispatch:00000000-0000-4000-8000-000000000000',
      digest: `sha256:agenticloop.role-preparation.v2:${'d'.repeat(64)}`,
      task: {
        id: 'T-001',
        taskContractDigest: `sha256:v1:${'c'.repeat(64)}`,
        dispatchCarrierDigest: `sha256:${'e'.repeat(64)}`,
        currentCarrierDigest: `sha256:${'e'.repeat(64)}`,
      },
      assignment: { worktree: '/repo', branch: 'task/T-001' },
      repository: { head: SHA256 },
    };
    const evidence = repositoryEvidence(packet, { head: SHA256 });
    evidence.productAttribution = { range: { base: SHA256, head: SHA256 }, commits: [SHA256] };
    const wire = readyReturn(packet, evidence);
    const validated = validateRoleReturn(wire);
    assert.equal(validated.ok, true, validated.errors.join('\n'));
    const abbreviated = JSON.parse(JSON.stringify(wire));
    abbreviated.productAttribution = { range: { base: SHA256, head: SHA256 }, commits: [SHA256.slice(0, 7)] };
    assert.equal(validateRoleReturn(abbreviated).ok, false);
  });

  it('proves a collection of identities shares one object format', () => {
    assert.equal(gitObjectFormat(SHA1), 'sha1');
    assert.equal(gitObjectFormat(SHA256), 'sha256');
    assert.equal(gitObjectFormat(SHA1.slice(0, 7)), null);
    assert.equal(gitObjectFormat('A'.repeat(40)), null);

    assert.equal(sameGitObjectFormat([]), true);
    assert.equal(sameGitObjectFormat([SHA1, SHA1, SHA1]), true);
    assert.equal(sameGitObjectFormat([SHA256, SHA256]), true);
    // Absent values are not supplied identities; presence stays the caller's
    // own check so a missing field and a mixed format remain distinct faults.
    assert.equal(sameGitObjectFormat([SHA1, null, undefined]), true);

    assert.equal(sameGitObjectFormat([SHA1, SHA256]), false);
    assert.equal(sameGitObjectFormat([SHA256, SHA1]), false);
    assert.equal(sameGitObjectFormat([SHA1, SHA1, SHA256]), false);
    // Abbreviations are never accepted, even when every value is abbreviated
    // to the same length.
    assert.equal(sameGitObjectFormat([SHA1.slice(0, 7), SHA1.slice(0, 7)]), false);
    assert.equal(sameGitObjectFormat([SHA1, 'A'.repeat(40)]), false);
  });

  it('derives commit ranges from a real SHA-256 repository', { skip: !sha256RepoSupported() && 'git lacks --object-format=sha256' }, () => {
    const root = mkdtempSync(join(temp, 'sha256-repo-'));
    const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(run(['init', '--object-format=sha256']).status, 0);
    run(['config', 'user.name', 'Agentic Loop Test']);
    run(['config', 'user.email', 'loop@example.test']);
    const commit = (path, content, message) => {
      writeFileSync(join(root, path), content, 'utf8');
      assert.equal(run(['add', path]).status, 0);
      assert.equal(run(['commit', '-m', message]).status, 0);
      return String(run(['rev-parse', 'HEAD']).stdout).trim();
    };
    const base = commit('a.txt', 'a\n', 'base\n\nTask: T-001\nAgent: engineer');
    const head = commit('b.txt', 'b\n', 'work\n\nTask: T-001\nAgent: engineer');
    assert.equal(base.length, 64);
    assert.equal(head.length, 64);
    const derived = deriveCommitRange({ runGit: run, baseHead: base, head, taskId: 'T-001', roleId: 'engineer' });
    assert.equal(derived.ok, true, derived.message);
    assert.deepEqual(derived.commits, [head]);
    assert.deepEqual(derived.changedPaths, ['b.txt']);
  });
});

/**
 * Mixed object formats in P35-04 envelopes.
 *
 * One repository has exactly one object format, so a 40/64 mix is two
 * repositories' identities spliced into one evidence claim. Every P35-04
 * consumer must reject it outright rather than resolving whichever identity
 * happens to be reachable.
 */
describe('mixed Git object formats in dispatch and return evidence', () => {
  const MIXED = /share one Git object format/;

  it('validateDispatchPreparation rejects a mixed repository binding', async () => {
    const fixture = await createDispatchFixture(temp, 'oid-dispatch');
    const prepared = prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(validateDispatchPreparation(prepared.packet, fixture.options).ok, true);

    // A SHA-256 head beside a SHA-1 base is rejected even though the packet
    // digest is honestly recomputed over the mutated packet.
    const mixed = structuredClone(prepared.packet);
    mixed.repository.head = SHA256;
    mixed.digest = dispatchPreparationDigest(mixed);
    const result = validateDispatchPreparation(mixed, fixture.options);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), MIXED);

    const mixedTree = structuredClone(prepared.packet);
    mixedTree.repository.baseTree = SHA256;
    mixedTree.digest = dispatchPreparationDigest(mixedTree);
    assert.match(validateDispatchPreparation(mixedTree, fixture.options).errors.join('\n'), MIXED);
  });

  it('validateRoleReturn rejects mixed heads, ranges, and commit lists', async () => {
    const fixture = await createDispatchFixture(temp, 'oid-return');
    const prepared = prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const evidence = repositoryEvidence(prepared.packet);
    assert.equal(validateRoleReturn(readyReturn(prepared.packet, evidence)).ok, true);

    // The constructor refuses to mint a mixed-format return at all, so every
    // hostile variant below is patched raw JSON.
    assert.throws(() => {
      const forced = repositoryEvidence(prepared.packet, { head: SHA256 });
      forced.productAttribution = { range: { base: prepared.packet.repository.head, head: SHA256 }, commits: [SHA256] };
      readyReturn(prepared.packet, forced);
    }, MIXED);

    // A SHA-256 product head against a SHA-1 product base.
    const mixedHead = structuredClone(readyReturn(prepared.packet, evidence));
    mixedHead.productHead = SHA256;
    mixedHead.productAttribution.range.head = SHA256;
    assert.match(validateRoleReturn(mixedHead).errors.join('\n'), MIXED);

    // One SHA-256 commit smuggled into an otherwise SHA-1 range.
    const mixedCommits = structuredClone(readyReturn(prepared.packet, evidence));
    mixedCommits.productAttribution.commits = [...mixedCommits.productAttribution.commits, SHA256];
    assert.match(validateRoleReturn(mixedCommits).errors.join('\n'), MIXED);

    // An abbreviation stays its own distinct fault, not a format complaint.
    const abbreviated = structuredClone(readyReturn(prepared.packet, evidence));
    abbreviated.productAttribution.commits = [SHA1.slice(0, 7)];
    const abbreviatedResult = validateRoleReturn(abbreviated);
    assert.equal(abbreviatedResult.ok, false);
    assert.match(abbreviatedResult.errors.join('\n'), /must be full Git identities/);
    assert.doesNotMatch(abbreviatedResult.errors.join('\n'), MIXED);
  });

  it('receiveRoleReturn rejects mixed repository evidence and never reaches proceed', async () => {
    const fixture = await createDispatchFixture(temp, 'oid-evidence');
    const prepared = prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));

    // The wire is internally consistent; only the refetched repository evidence
    // mixes formats, so the fault has to be caught on the evidence itself.
    const evidence = repositoryEvidence(prepared.packet);
    const roleReturn = readyReturn(prepared.packet, evidence);
    const mixedEvidence = structuredClone(evidence);
    mixedEvidence.productAttribution.commits = [SHA256];
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn),
      packet: prepared.packet,
      refetchTask: fixture.snapshot,
      refetchRepositoryEvidence: () => mixedEvidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, mixedEvidence),
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.match(received.validation.errors.join('\n'), MIXED);
    assert.notEqual(received.validation.evidenceState, 'current');
    assert.notEqual(received.validation.disposition, 'proceed');
  });

  it('rejects a mixed GitHub/injected return with no runGit available', async () => {
    const fixture = await createDispatchFixture(temp, 'oid-github');
    const githubSnapshot = { ...fixture.snapshot(), backend: 'github', carrier: 'issue:42' };
    const githubReadiness = {
      ...fixture.readiness,
      evidence: createTaskReadinessEvidence({
        ...fixture.readiness.evidence,
        backend: 'github',
        task: { id: 'T-001', carrier: 'issue:42', expectedDigest: githubSnapshot.digest },
      }),
    };
    const githubFixture = {
      ...fixture,
      refetchTask: () => githubSnapshot,
      readiness: githubReadiness,
      refetchReadiness: () => githubReadiness,
      assignment: {
        ...fixture.assignment,
        canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/github.md'],
      },
    };
    const prepared = prepareRoleDispatch(githubFixture, fixture.options);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));

    const pr = { state: 'open', number: 42, url: 'https://example.test/pull/42' };
    const honest = repositoryEvidence(prepared.packet, { pr });
    const honestReturn = readyReturn(prepared.packet, honest);
    // The honest single-format GitHub return still succeeds without a Git reader:
    // its trust comes from the receipt signed at the transport edge.
    const accepted = receiveRoleReturn({
      raw: JSON.stringify(honestReturn),
      packet: prepared.packet,
      refetchTask: () => githubSnapshot,
      refetchRepositoryEvidence: () => honest,
      ...producerBinding(fixture.trust, prepared.packet, honestReturn, honest),
    }, fixture.options);
    assert.equal(accepted.ok, true, accepted.validation.errors?.join('\n'));
    assert.equal(accepted.validation.disposition, 'proceed');

    // The same transport carrying a SHA-256 head over a SHA-1 base cannot reach
    // current/proceed, even though no runGit exists to rederive anything and the
    // producer receipt authenticates the exact mixed evidence digest.
    //
    // The hostile wire is patched raw JSON, not built through createRoleReturn:
    // a real attacker posts bytes and never calls our constructor, so the
    // receive boundary itself has to reject the mix.
    const mixed = repositoryEvidence(prepared.packet, { head: SHA256, pr });
    mixed.productAttribution = { range: { base: prepared.packet.repository.head, head: SHA256 }, commits: [SHA256] };
    const mixedReturn = structuredClone(honestReturn);
    mixedReturn.productHead = SHA256;
    mixedReturn.workflowHead = SHA256;
    mixedReturn.productAttribution = structuredClone(mixed.productAttribution);
    const rejected = receiveRoleReturn({
      raw: JSON.stringify(mixedReturn),
      packet: prepared.packet,
      refetchTask: () => githubSnapshot,
      refetchRepositoryEvidence: () => mixed,
      ...producerBinding(fixture.trust, prepared.packet, mixedReturn, mixed),
    }, fixture.options);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.validation.producerRole, 'engineer');
    assert.match(rejected.validation.errors.join('\n'), MIXED);
    assert.notEqual(rejected.validation.evidenceState, 'current');
    assert.notEqual(rejected.validation.disposition, 'proceed');
  });
});
