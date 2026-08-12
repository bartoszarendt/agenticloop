import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { targetRepositoryIdentity } from '../src/host-trust.js';
import {
  createDispatchFixture,
  closeoutCertificationFingerprint,
  createResettableDispatchFixture,
  createResettableDispatchFixturePool,
  git,
  prepare,
} from './helpers/dispatch-fixture.js';

let temp;

before(() => {
  temp = mkdtempSync(join(tmpdir(), 'agenticloop-dispatch-fixture-'));
});

after(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe('scaffold dispatch fixture cloning', () => {
  it('keeps clone roots, filesystems, trust, and mutable state independent', async () => {
    const options = { scaffold: true, additionalAllowedPaths: ['docs/**'] };
    const cloneA = await createDispatchFixture(temp, 'a', options);
    const cloneB = await createDispatchFixture(temp, 'b', options);

    assert.notEqual(cloneA.root, cloneB.root);
    assert.equal(cloneA.trust.target, cloneA.root);
    assert.equal(cloneB.trust.target, cloneB.root);
    assert.equal(cloneA.trust.repositoryIdentity, targetRepositoryIdentity(cloneA.root));
    assert.equal(cloneB.trust.repositoryIdentity, targetRepositoryIdentity(cloneB.root));
    assert.notEqual(cloneA.trust.repositoryIdentity, cloneB.trust.repositoryIdentity);
    assert.notEqual(cloneA.trust, cloneB.trust);
    assert.notEqual(cloneA.trust.privateKey, cloneB.trust.privateKey);
    assert.notEqual(cloneA.operatorTrustRoot, cloneB.operatorTrustRoot);
    assert.notEqual(cloneA.trustStorePath, cloneB.trustStorePath);
    const trustStoreRelative = relative(cloneA.operatorTrustRoot, cloneA.trustStorePath);
    assert.equal(isAbsolute(trustStoreRelative) || trustStoreRelative.startsWith('..'), false);
    assert.ok(existsSync(cloneA.trustStorePath));
    assert.equal(JSON.parse(readFileSync(cloneA.trustStorePath, 'utf8')).target.repositoryIdentity, cloneA.trust.repositoryIdentity);

    cloneA.readiness.result.errors.push('clone-a-only');
    assert.deepEqual(cloneB.readiness.result.errors, []);
    writeFileSync(join(cloneA.root, 'clone-a-only.txt'), 'changed\n', 'utf8');
    writeFileSync(cloneA.taskPath, 'clone a mutation\n', 'utf8');
    assert.equal(existsSync(join(cloneB.root, 'clone-a-only.txt')), false);
    assert.notEqual(readFileSync(cloneB.taskPath, 'utf8'), 'clone a mutation\n');

    const cloneC = await createDispatchFixture(temp, 'c', options);
    assert.equal(existsSync(join(cloneC.root, 'clone-a-only.txt')), false);
    assert.notEqual(readFileSync(cloneC.taskPath, 'utf8'), 'clone a mutation\n');
  });

  it('separates materially different option sets and preserves Git branch and HEAD', async () => {
    const first = await createDispatchFixture(temp, 'options-a', {
      scaffold: true,
      projectMapContent: '---\nsetup_status: confirmed\n---\n\n# First\n',
    });
    const second = await createDispatchFixture(temp, 'options-b', {
      scaffold: true,
      projectMapContent: '---\nsetup_status: confirmed\n---\n\n# Second\n',
    });

    assert.match(readFileSync(join(first.root, '.agenticloop', 'project.md'), 'utf8'), /# First/);
    assert.match(readFileSync(join(second.root, '.agenticloop', 'project.md'), 'utf8'), /# Second/);
    for (const fixture of [first, second]) {
      assert.equal(git(fixture.root, ['branch', '--show-current']), 'task/T-001');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), fixture.repository().head);
      assert.equal(dirname(fixture.taskPath), join(fixture.root, '.agenticloop', 'tasks'));
    }
  });

  it('restores a signed fixture and all caller-declared external state at the same path', async () => {
    const operatorActivationRoot = join(temp, 'reset-operator-activation');
    const controller = await createResettableDispatchFixture(
      temp,
      'signed-reset',
      {},
      { resetPaths: [operatorActivationRoot] }
    );
    const initial = controller.take();
    const root = initial.root;
    const identity = initial.trust.repositoryIdentity;
    const head = git(root, ['rev-parse', 'HEAD']);
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    const taskBody = readFileSync(initial.taskPath, 'utf8');
    const decompositionPath = join(root, '.agenticloop', 'decompositions', 'T-001.json');
    const decomposition = readFileSync(decompositionPath, 'utf8');
    const trustStore = readFileSync(initial.trustStorePath, 'utf8');
    assert.equal(prepare(initial).ok, true);

    writeFileSync(initial.taskPath, 'mutated task\n', 'utf8');
    writeFileSync(decompositionPath, '{}\n', 'utf8');
    rmSync(join(root, 'src', 'existing.js'));
    writeFileSync(join(root, 'untracked.txt'), 'leak\n', 'utf8');
    writeFileSync(join(root, '.agenticloop', 'task-contract-history', 'leak.json'), '{}\n', 'utf8');
    writeFileSync(initial.trustStorePath, '{}\n', 'utf8');
    mkdirSync(operatorActivationRoot, { recursive: true });
    writeFileSync(join(operatorActivationRoot, 'leak.json'), '{}\n', 'utf8');
    git(root, ['commit', '--allow-empty', '-m', 'leaked head']);

    const restored = controller.take();
    assert.equal(restored.root, root);
    assert.equal(restored.trust.target, root);
    assert.equal(restored.trust.repositoryIdentity, identity);
    assert.equal(controller.repositoryIdentity, identity);
    assert.equal(git(root, ['rev-parse', 'HEAD']), head);
    assert.equal(git(root, ['rev-parse', 'HEAD^{tree}']), tree);
    assert.equal(git(root, ['status', '--porcelain']), '');
    assert.equal(readFileSync(restored.taskPath, 'utf8'), taskBody);
    assert.equal(readFileSync(decompositionPath, 'utf8'), decomposition);
    assert.equal(readFileSync(restored.trustStorePath, 'utf8'), trustStore);
    assert.equal(existsSync(join(root, 'untracked.txt')), false);
    assert.equal(existsSync(join(root, '.agenticloop', 'task-contract-history', 'leak.json')), false);
    assert.equal(existsSync(operatorActivationRoot), false);
    assert.equal(prepare(restored).ok, true, 'host-signed activation remains valid after same-path reset');

    restored.readiness.result.errors.push('must-not-leak');
    writeFileSync(join(root, 'second-leak.txt'), 'leak\n', 'utf8');
    const restoredAgain = controller.take();
    assert.deepEqual(restoredAgain.readiness.result.errors, []);
    assert.equal(existsSync(join(root, 'second-leak.txt')), false);
    assert.equal(prepare(restoredAgain).ok, true);
  });

  it('does not share certification fingerprints across clean heads with the same tree', async () => {
    const fixture = await createDispatchFixture(temp, 'certification-head');
    const options = { tasks: ['T-001'] };
    const firstHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const tree = git(fixture.root, ['rev-parse', 'HEAD^{tree}']);
    const firstFingerprint = closeoutCertificationFingerprint(fixture.root, options);

    git(fixture.root, ['commit', '--allow-empty', '-m', 'same tree, distinct certification head']);

    const secondHead = git(fixture.root, ['rev-parse', 'HEAD']);
    assert.equal(git(fixture.root, ['status', '--porcelain', '--untracked-files=all']), '');
    assert.equal(git(fixture.root, ['rev-parse', 'HEAD^{tree}']), tree);
    assert.notEqual(secondHead, firstHead);
    assert.notEqual(
      closeoutCertificationFingerprint(fixture.root, options),
      firstFingerprint,
      'a distinct clean HEAD/history must not reuse a certification checkpoint or artifact'
    );
  });

  it('distinguishes tree, options, activation, and operator trust inputs directly', async () => {
    const fixture = await createDispatchFixture(temp, 'certification-inputs');
    const activationRoot = join(temp, 'certification-activation');
    const trustRoot = join(temp, 'certification-trust');
    mkdirSync(activationRoot, { recursive: true });
    mkdirSync(trustRoot, { recursive: true });
    const options = { tasks: ['T-001'], mode: 'standard' };
    const baseline = closeoutCertificationFingerprint(fixture.root, options, [activationRoot, trustRoot]);

    assert.notEqual(
      closeoutCertificationFingerprint(fixture.root, { ...options, mode: 'waived' }, [activationRoot, trustRoot]),
      baseline,
      'material harness options must distinguish certification inputs'
    );
    writeFileSync(join(activationRoot, 'changed.json'), '{}\n', 'utf8');
    const changedActivation = closeoutCertificationFingerprint(fixture.root, options, [activationRoot, trustRoot]);
    assert.notEqual(changedActivation, baseline, 'activation state must distinguish certification inputs');
    rmSync(join(activationRoot, 'changed.json'));
    writeFileSync(join(trustRoot, 'changed.json'), '{}\n', 'utf8');
    assert.notEqual(
      closeoutCertificationFingerprint(fixture.root, options, [activationRoot, trustRoot]),
      baseline,
      'operator trust state must distinguish certification inputs'
    );
    rmSync(join(trustRoot, 'changed.json'));

    writeFileSync(join(fixture.root, 'tree-change.txt'), 'changed\n', 'utf8');
    git(fixture.root, ['add', 'tree-change.txt']);
    git(fixture.root, ['commit', '-m', 'distinct certification tree']);
    assert.notEqual(
      closeoutCertificationFingerprint(fixture.root, options, [activationRoot, trustRoot]),
      baseline,
      'a distinct committed tree must distinguish certification inputs'
    );
  });

  it('refuses dirty gitRestore checkpoints and never shares an active pool lease', async () => {
    const operatorActivationRoot = join(temp, 'pool-operator-activation');
    const pool = createResettableDispatchFixturePool();
    const first = await pool.acquire(temp, 'pool', {}, { resetPaths: [operatorActivationRoot] });
    writeFileSync(first.taskPath, 'dirty before checkpoint\n', 'utf8');
    assert.throws(
      () => pool.checkpoint(first.root, 'dirty', { gitRestore: true }),
      /requires a clean committed worktree/
    );

    pool.checkpoint(first.root, 'certified', { gitRestore: false });
    const second = await pool.acquire(temp, 'pool', {}, { resetPaths: [operatorActivationRoot] });
    assert.notEqual(second.root, first.root, 'a certified entry remains unavailable while leased');

    pool.releaseAll();
    const reused = await pool.acquire(temp, 'pool', {}, { resetPaths: [operatorActivationRoot] });
    assert.equal(reused.root, first.root, 'released entries remain available for serial reuse');
  });
});
