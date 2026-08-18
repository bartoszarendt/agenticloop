/**
 * Wall-clock freshness is a backstop, not a session timer.
 *
 * The field session's Engineer run lasted about 130 minutes against a flat
 * 3,600-second decomposition freshness window, so the observation expired before
 * return could be produced - without any dependency actually changing. The clock
 * was measuring how long the work took, not whether the evidence was stale.
 *
 * The rule these cases pin is the distinction, not the number: a wall clock is
 * only load-bearing for state that can change *without* an observable
 * repository event. On the files backend it cannot - dependency statuses are
 * task records inside the repository, and the scan already binds inventory
 * membership, carrier digests, the protected contract, and the base tree, so a
 * real change breaks a binding and is refused semantically. On GitHub it can,
 * because issue state lives outside the repository and nothing local would
 * notice, so there the clock stays short.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { defaultDecompositionFreshnessSeconds } from '../src/task-cli.js';
import { defaultDependencyFreshnessSeconds, parseDependencySnapshot } from '../src/task-evidence-contract.js';
import { PARALLEL_SCAN_MAX_FRESHNESS_SECONDS } from '../src/parallel-scan.js';
import { createDispatchFixture, git as fixtureGit } from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { evaluateHandoffPreflight } from '../src/handoff-preflight.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-freshness-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

describe('the freshness default follows the backend, not a constant', () => {
  it('keeps a short window only where state changes without a repository event', () => {
    // GitHub issue state can change with no local event at all, so the clock is
    // the only mechanism there and stays short.
    assert.equal(defaultDecompositionFreshnessSeconds('github'), 3600);
  });

  it('lets the semantic bindings carry the files backend', () => {
    // Every files-backed dependency status is a repository file. The scan's
    // bindings catch real changes, so the clock is a backstop at the trusted
    // maximum rather than a timer on the Engineer session.
    assert.equal(defaultDecompositionFreshnessSeconds('files'), PARALLEL_SCAN_MAX_FRESHNESS_SECONDS);
    assert.ok(
      defaultDecompositionFreshnessSeconds('files') > 130 * 60,
      'the default must outlast an ordinary Engineer session, which 3600 did not'
    );
  });

  it('never exceeds the trusted maximum for any backend', () => {
    for (const backend of ['files', 'github']) {
      const seconds = defaultDecompositionFreshnessSeconds(backend);
      assert.ok(Number.isSafeInteger(seconds) && seconds > 0);
      assert.ok(seconds <= PARALLEL_SCAN_MAX_FRESHNESS_SECONDS, `${backend} exceeds the trusted maximum`);
    }
  });
});

describe('the dependency snapshot gets the same backend-derived default', () => {
  it('derives the window when the snapshot declares none', () => {
    // The field run failed on a hand-authored `{"maxAgeSeconds": 3600}` that no
    // producer had chosen: "observed 3758s ago, policy allows 3600s". A snapshot
    // that declares no window now gets the defensible one instead of being
    // refused for lacking a number nothing produces.
    const observedAt = new Date().toISOString();
    const document = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt, statuses: {},
    };
    const parsed = parseDependencySnapshot(JSON.stringify(document), { sourceRef: 'dependencies.json' });
    assert.equal(parsed.ok, true, parsed.errors.join('; '));
    assert.equal(parsed.evidence.freshnessPolicy.maxAgeSeconds, defaultDependencyFreshnessSeconds('files'));
    assert.equal(
      parseDependencySnapshot(JSON.stringify(document), { sourceRef: 'dependencies.json', backend: 'github' })
        .evidence.freshnessPolicy.maxAgeSeconds,
      defaultDependencyFreshnessSeconds('github')
    );
  });

  it('outlasts the multi-delegation cycle the old default expired inside', () => {
    assert.equal(defaultDependencyFreshnessSeconds('files'), defaultDecompositionFreshnessSeconds('files'));
    assert.ok(defaultDependencyFreshnessSeconds('files') > 3758,
      'the field observation was refused at 3758 seconds under the authored 3600');
  });

  it('still honours a declared window as evidence rather than a setting', () => {
    const parsed = parseDependencySnapshot(JSON.stringify({
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 600 }, statuses: {},
    }), { sourceRef: 'dependencies.json' });
    assert.equal(parsed.ok, true, parsed.errors.join('; '));
    assert.equal(parsed.evidence.freshnessPolicy.maxAgeSeconds, 600);
  });

  it('still refuses a malformed declared window', () => {
    const parsed = parseDependencySnapshot(JSON.stringify({
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 0 }, statuses: {},
    }), { sourceRef: 'dependencies.json' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join('; '), /freshnessPolicy must be/);
  });
});

describe('the emitted observation carries the new default', () => {
  it('writes a files decomposition that outlasts an ordinary Engineer session', async () => {
    // The change is to what `prepare-decomposition` *emits*. An observation that
    // already declares a policy keeps it - a declared window is evidence, not a
    // setting - so the assertion is on a freshly produced source.
    const fixture = await createDispatchFixture(temp, 'freshness-emitted');
    const sourceRef = '.agenticloop/decompositions/T-001.json';
    const head = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    const produced = await runCliInProcess([
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'fixture-work-unit',
      '--source-ref', sourceRef,
      '--source-revision', `git-commit:${head}`,
      '--base', head,
      '--dependencies', 'dependencies.json',
      '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(produced.status, 0, produced.stderr);

    const emitted = JSON.parse(produced.stdout);
    const maxAge = emitted?.scan?.freshnessPolicy?.maxAgeSeconds
      ?? emitted?.artifact?.scan?.freshnessPolicy?.maxAgeSeconds;
    assert.equal(maxAge, PARALLEL_SCAN_MAX_FRESHNESS_SECONDS);
    assert.ok(maxAge > 130 * 60, 'the field session ran 130 minutes and expired under the old default');
  });

  it('still honours an explicitly requested window', async () => {
    // Relaxing a default must not remove the operator's ability to choose.
    const fixture = await createDispatchFixture(temp, 'freshness-explicit');
    const head = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    const produced = await runCliInProcess([
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'fixture-work-unit',
      '--source-ref', '.agenticloop/decompositions/T-001.json',
      '--source-revision', `git-commit:${head}`,
      '--base', head,
      '--dependencies', 'dependencies.json',
      '--max-age-seconds', '600',
      '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(produced.status, 0, produced.stderr);
    const emitted = JSON.parse(produced.stdout);
    const maxAge = emitted?.scan?.freshnessPolicy?.maxAgeSeconds
      ?? emitted?.artifact?.scan?.freshnessPolicy?.maxAgeSeconds;
    assert.equal(maxAge, 600);
  });
});

describe('semantic bindings still carry the weight', () => {
  it('binds the declared dependency set, not the snapshot file bytes', async () => {
    // Written as a stronger claim first - "any committed change to
    // dependencies.json is refused" - and that was wrong. The scan binds the
    // status set for *declared* dependencies (`statusCount: 0` for this task),
    // so a status for a task this one does not depend on is genuinely not
    // material. That is the over-invalidation correction in miniature: it is
    // a defect too, and this case guards against reintroducing it while
    // relaxing the clock.
    const fixture = await createDispatchFixture(temp, 'freshness-undeclared');
    const decomposition = JSON.parse(
      readFileSync(join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json'), 'utf8')
    );
    assert.equal(
      decomposition.scan.readinessContext.dependencies.statusCount, 0,
      'this fixture task declares no dependencies'
    );

    const clean = evaluateHandoffPreflight({
      target: fixture.root, taskId: 'T-001', backend: 'files', projectConfig: {}, io: {},
    });
    assert.equal(clean.ok, true, JSON.stringify(clean.errors));

    const dependencyPath = join(fixture.root, 'dependencies.json');
    const snapshot = JSON.parse(readFileSync(dependencyPath, 'utf8'));
    snapshot.statuses = { 'T-999': 'blocked' };
    writeFileSync(dependencyPath, JSON.stringify(snapshot), 'utf8');
    fixtureGit(fixture.root, ['add', '-A']);
    fixtureGit(fixture.root, ['commit', '-m', 'record an undeclared status\n\nTask: T-001\nAgent: maintainer']);

    const after = evaluateHandoffPreflight({
      target: fixture.root, taskId: 'T-001', backend: 'files', projectConfig: {}, io: {},
    });
    assert.equal(after.ok, true, `an undeclared dependency status is not material: ${JSON.stringify(after.errors)}`);
  });

  it('honours a declared short window rather than overriding it', async () => {
    // A window an observation declared is part of that evidence. Changing the
    // default must not retroactively widen an observation that chose to be
    // short-lived.
    const fixture = await createDispatchFixture(temp, 'freshness-declared');
    const decompositionPath = join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json');
    const decomposition = JSON.parse(readFileSync(decompositionPath, 'utf8'));
    const declared = decomposition.scan.freshnessPolicy.maxAgeSeconds;
    const past = new Date(Date.parse(decomposition.scan.observedAt) + (declared + 60) * 1000).toISOString();
    const result = evaluateHandoffPreflight({
      target: fixture.root, taskId: 'T-001', backend: 'files',
      projectConfig: {}, io: {}, now: past,
    });
    assert.equal(result.ok, false, 'a declared window is still enforced past its end');
  });
});
