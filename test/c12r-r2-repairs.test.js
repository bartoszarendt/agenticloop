/**
 * P35-C12R second-review findings C12R-R2-F1 through C12R-R2-F4.
 *
 * The first review response (`61c714a`) passed every suite it shipped and was
 * still wrong in four places. What the passing suites had in common is that they
 * asserted over *fragments*: a command prefix, a boolean disposition, a refusal
 * message. None of them asserted that the artifact a role or operator actually
 * receives is usable.
 *
 * These cases assert the whole thing:
 *
 * - F1: every rendered repair is accepted by the real CLI parser, names no
 *   mutually exclusive option pair, and - for the one status with an
 *   unambiguous forward move - actually performs the repair end to end.
 * - F2: a mutation reports the state it produced, not the state it read.
 * - F3: every superseded identity reports the digest that names its revocation
 *   directory, in JSON and in text.
 * - F4: the explicit-path key reader proves membership beneath the configured
 *   operator root, not merely absence from the target repository.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
  dispatchableLifecycleRepair,
  dispatchableLifecycleRepairPlan,
  renderRepairPlan,
} from '../src/dispatchability.js';
import { KNOWN_TASK_STATUSES } from '../src/task-transition.js';
import { COMMAND_REGISTRY, parseCommandArgs } from '../src/cli-registry.js';
import {
  loadOperatorActivationKey,
  operatorActivationKeyPathForIdentity,
  readOperatorActivationKeyDocument,
  renderOperatorActivationKeyDocument,
} from '../src/activation-trust.js';
import { HOST_SIGNATURE_ALGORITHM, exportPublicKey, targetRepositoryIdentity } from '../src/host-trust.js';
import {
  legacyRepositoryAuthorityIdentities,
  repositoryAuthorityDigest,
} from '../src/repository-identity.js';
import { cmdActivation } from '../src/activation-cli.js';

import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/git-fixture.js';
import { makePreflightTask, makeDecomposition, taskPath } from './helpers/c12r-preflight-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-c12r-r2-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

// ── C12R-R2-F1 ────────────────────────────────────────────────────────────────

/** Every command a repair plan can hand a caller, including its alternatives. */
function everyCommand(plan) {
  return [
    ...plan.reads,
    ...(plan.primary ? [plan.primary] : []),
    ...plan.alternatives,
  ];
}

/** Split one rendered `npx agenticloop ...` command into a parseable argv. */
function toArgv(command) {
  const tokens = command.split(' ').filter(Boolean);
  assert.deepEqual(tokens.slice(0, 2), ['npx', 'agenticloop'], `not an agenticloop command: ${command}`);
  return tokens.slice(2);
}

describe('C12R-R2-F1 every rendered lifecycle repair is a real, valid command', () => {
  const domain = [...KNOWN_TASK_STATUSES, 'made-up', '', null, undefined];

  it('never offers two mutually exclusive baseline options in one command', () => {
    // The exact defect: `--base <ref> --base-paths <path>` in a single command,
    // which `readExplicitBaseEvidence` refuses as an ambiguous baseline. The
    // assertion is on exclusivity itself, not on a command prefix.
    for (const status of domain) {
      const plan = dispatchableLifecycleRepairPlan('T-018', status);
      for (const entry of everyCommand(plan)) {
        const argv = toArgv(entry.command);
        const hasBase = argv.includes('--base');
        const hasBasePaths = argv.includes('--base-paths');
        assert.equal(
          hasBase && hasBasePaths,
          false,
          `'${status}' repair supplies both baselines at once: ${entry.command}`
        );
      }
    }
  });

  it('expresses the baseline choice as one primary command and one identified alternative', () => {
    const plan = dispatchableLifecycleRepairPlan('T-018', 'draft');
    assert.ok(plan.primary, 'draft has one unambiguous forward move');
    assert.ok(toArgv(plan.primary.command).includes('--base'));
    assert.equal(plan.alternatives.length, 1);
    const [alternative] = plan.alternatives;
    assert.ok(toArgv(alternative.command).includes('--base-paths'));
    assert.ok(alternative.when, 'an alternative states the condition that selects it');
  });

  it('is accepted by the real CLI parser once its declared placeholders are replaced', () => {
    // The parser is the boundary that rejected the old string. Every command,
    // for every status, is routed through the actual registry and the actual
    // `parseCommandArgs` - so an invented subcommand or an unknown option is a
    // test failure rather than something a role discovers at repair time.
    const substitutions = {
      '<digest>': `sha256:${'0'.repeat(64)}`,
      '<base-ref>': 'HEAD',
      '<base-paths.json>': '.agenticloop/tmp/base-paths.json',
      '<dependencies.json>': '.agenticloop/tmp/dependencies.json',
    };
    for (const status of domain) {
      const plan = dispatchableLifecycleRepairPlan('T-018', status);
      for (const entry of everyCommand(plan)) {
        const argv = toArgv(entry.command).map(token => {
          if (!token.startsWith('<')) return token;
          assert.ok(
            entry.placeholders.includes(token),
            `${token} is used but not declared as a placeholder of: ${entry.command}`
          );
          return substitutions[token] ?? assert.fail(`unmodelled placeholder ${token}`);
        });
        assert.equal(
          argv.some(token => token.startsWith('<')),
          false,
          `unreplaced placeholder remains in: ${argv.join(' ')}`
        );
        const [family, sub, ...rest] = argv;
        const spec = COMMAND_REGISTRY[family]?.subcommands?.[sub];
        assert.ok(spec, `'${family} ${sub}' is not a real command (from: ${entry.command})`);
        assert.doesNotThrow(
          () => parseCommandArgs(`${family} ${sub}`, spec, rest),
          `the real parser rejects: ${entry.command}`
        );
      }
    }
  });

  it('declares no placeholder it does not use', () => {
    for (const status of domain) {
      for (const entry of everyCommand(dispatchableLifecycleRepairPlan('T-018', status))) {
        for (const placeholder of entry.placeholders) {
          assert.ok(
            entry.command.includes(placeholder),
            `${placeholder} is declared but absent from: ${entry.command}`
          );
        }
      }
    }
  });

  it('states what is true where no command is safe, and invents none', () => {
    for (const status of ['accepted', 'closed']) {
      const plan = dispatchableLifecycleRepairPlan('T-016', status);
      assert.equal(plan.primary, null);
      assert.equal(plan.alternatives.length, 0);
      assert.match(plan.statement, /already completed its lifecycle/);
      assert.doesNotMatch(renderRepairPlan(plan), /npx agenticloop/);
    }
  });

  it('renders one identical repair at every boundary', () => {
    // Preflight, packet preparation, prepared-packet validation, and role start
    // all read the same renderer, so drift between them is not expressible.
    const rendered = dispatchableLifecycleRepair('T-018', 'draft');
    assert.equal(rendered, renderRepairPlan(dispatchableLifecycleRepairPlan('T-018', 'draft')));
    assert.equal(dispatchableLifecycleRepairPlan('T-018', 'draft').code, DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE);
  });

  it('performs the repair it names, through the real CLI, on a real task', async () => {
    // The integration boundary the first review response never crossed: run the
    // rendered command and check the lifecycle actually moves.
    const target = mkdtempSync(join(temp, 'repair-e2e-'));
    createTaskProjectFixture(target);
    makePreflightTask(target, 'T-018', { status: 'draft' });
    // Scope globs must match something in the base tree, or authoring readiness
    // refuses for a reason unrelated to the command shape.
    mkdirSync(join(target, 'src'), { recursive: true });
    mkdirSync(join(target, 'docs'), { recursive: true });
    writeFileSync(join(target, 'src', 'existing.txt'), 'x\n', 'utf8');
    writeFileSync(join(target, 'docs', 'existing.md'), '# d\n', 'utf8');
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'task\n\nTask: T-018\nAgent: maintainer']);
    makeDecomposition(target, 'T-018');
    const baseline = await runCliInProcess([
      'task', 'establish-baseline', 'T-018',
      '--actor', 'Agentic Loop Test', '--authority', 'plan:P35-C12R', '--target', target,
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'readiness evidence\n\nTask: T-018\nAgent: maintainer']);

    const lint = await runCliInProcess(['task', 'lint', 'T-018', '--json', '--target', target]);
    assert.equal(lint.status, 0, lint.stderr);
    const digest = JSON.parse(lint.stdout)[0].digest;
    const head = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).stdout).trim();

    const plan = dispatchableLifecycleRepairPlan('T-018', 'draft');
    const argv = toArgv(plan.primary.command).map(token => {
      switch (token) {
        case '<digest>': return digest;
        case '<base-ref>': return head;
        case '<dependencies.json>': return '.agenticloop/decompositions/T-018.dependencies.json';
        default: return token;
      }
    });
    const applied = await runCliInProcess([...argv, '--target', target]);
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
    assert.match(readFileSync(taskPath(target, 'T-018'), 'utf8'), /^status: agent-ready$/m);
  });
});

// ── C12R-R2-F2 and C12R-R2-F3 ────────────────────────────────────────────────

function keyMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync(HOST_SIGNATURE_ALGORITHM);
  const publicKeyBase64 = exportPublicKey(publicKey);
  return {
    keyId: `operator-${createHash('sha256').update(publicKeyBase64, 'utf8').digest('hex').slice(0, 16)}`,
    algorithm: HOST_SIGNATURE_ALGORITHM,
    publicKey: publicKeyBase64,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A fixture whose superseded identities come from the *real* host derivation.
 *
 * An earlier draft of these cases invented `<identity>-v1-spelling-0`, which the
 * CLI never derives, so `migrate-identity` found nothing and the migrated branch
 * - the branch that carried the defect - was never entered. Using the real
 * derivation means a host with superseded spellings (Windows, where the defect
 * came from) exercises a genuine migration, and a host without them (POSIX,
 * where v1 and v2 agree by construction) is reported as such rather than
 * pretended over.
 */
function identityFixture(name) {
  const root = mkdtempSync(join(temp, `${name}-`));
  const target = join(root, 'target');
  const operatorActivationRoot = join(root, 'operator');
  mkdirSync(target, { recursive: true });
  mkdirSync(operatorActivationRoot, { recursive: true });
  const currentIdentity = targetRepositoryIdentity(target);
  const legacyIdentities = legacyRepositoryAuthorityIdentities(target);
  return {
    root,
    target,
    operatorActivationRoot,
    currentIdentity,
    legacyIdentities,
    hasSupersededSpellings: legacyIdentities.length > 0,
  };
}

function writeLegacyKey(fx, identity, material = keyMaterial()) {
  const path = operatorActivationKeyPathForIdentity(identity, fx.operatorActivationRoot);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, renderOperatorActivationKeyDocument({ repositoryIdentity: identity, ...material }), 'utf8');
  return { path, material };
}

/** Drive the real `activation` command family with captured output. */
async function runActivation(fx, args) {
  const out = [];
  const err = [];
  const io = {
    out: line => out.push(String(line)),
    err: line => err.push(String(line)),
    operatorActivationRoot: fx.operatorActivationRoot,
    cwd: fx.target,
    env: process.env,
  };
  const status = await cmdActivation([...args, '--target', fx.target], io);
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('C12R-R2-F2 a migration reports the state it produced', () => {
  it('reports the migrated key as present, in JSON', async function () {
    const fx = identityFixture('migrate-json');
    if (!fx.hasSupersededSpellings) {
      // POSIX derives v1 and v2 identically, so there is no migration to run
      // and the defective branch is unreachable. Recorded as a platform
      // coverage limit rather than asserted around.
      this.skip();
      return;
    }
    const { material } = writeLegacyKey(fx, fx.legacyIdentities[0]);
    const before = JSON.parse((await runActivation(fx, ['identity-status', '--json'])).stdout);
    assert.equal(before.currentKeyState, 'missing', 'the migration starts from no current key');
    assert.equal(before.disposition, 'migration_available', JSON.stringify(before, null, 2));

    const applied = await runActivation(fx, ['migrate-identity', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    const report = JSON.parse(applied.stdout);

    // The exact field contradiction: `migrated: true` beside the pre-migration
    // `currentKeyState: missing` and `currentKeyId: null`.
    assert.equal(report.migrated, true);
    assert.equal(report.disposition, 'migrated');
    assert.equal(report.currentKeyState, 'present', JSON.stringify(report, null, 2));
    assert.equal(report.currentKeyId, material.keyId);
    // The state it replaced is still reported, under its own name.
    assert.equal(report.priorKeyState, 'missing');
    assert.equal(report.priorKeyId, null);
    assert.equal(report.migratedFrom?.identity, fx.legacyIdentities[0]);
    // And the report agrees with what is actually on disk.
    const reloaded = loadOperatorActivationKey(fx.target, {
      operatorActivationRoot: fx.operatorActivationRoot,
    });
    assert.equal(reloaded.state, report.currentKeyState);
    assert.equal(reloaded.key?.keyId ?? null, report.currentKeyId);
  });

  it('never reports migrated: true alongside a missing current key', async () => {
    // Stated as an invariant over whatever disposition this host produces, so
    // it is meaningful on every platform even where no migration occurs.
    const fx = identityFixture('migrate-contradiction');
    if (fx.hasSupersededSpellings) writeLegacyKey(fx, fx.legacyIdentities[0]);
    const report = JSON.parse((await runActivation(fx, ['migrate-identity', '--json'])).stdout);
    assert.equal(
      report.migrated === true && report.currentKeyState !== 'present',
      false,
      `contradictory migration result: ${JSON.stringify(report, null, 2)}`
    );
  });

  it('reports the same current key state in text and in JSON', async function () {
    const fx = identityFixture('migrate-text');
    if (!fx.hasSupersededSpellings) { this.skip(); return; }
    const { material } = writeLegacyKey(fx, fx.legacyIdentities[0]);
    // Text mode runs the migration; JSON mode then reports the same state. Both
    // must describe the key that now exists, never the one that did not.
    const asText = await runActivation(fx, ['migrate-identity']);
    assert.match(asText.stdout, /operator key:\s+present/);
    assert.match(asText.stdout, new RegExp(material.keyId));
    assert.match(asText.stdout, /disposition:\s+migrated/);
    assert.match(asText.stdout, /migrated from:/);

    const asJson = JSON.parse((await runActivation(fx, ['identity-status', '--json'])).stdout);
    assert.equal(asJson.currentKeyState, 'present');
    assert.equal(asJson.currentKeyId, material.keyId);
  });

  it('is idempotent and reports the rerun truthfully', async function () {
    const fx = identityFixture('migrate-idempotent');
    if (!fx.hasSupersededSpellings) { this.skip(); return; }
    const { material } = writeLegacyKey(fx, fx.legacyIdentities[0]);
    const first = JSON.parse((await runActivation(fx, ['migrate-identity', '--json'])).stdout);
    assert.equal(first.disposition, 'migrated');
    const second = JSON.parse((await runActivation(fx, ['migrate-identity', '--json'])).stdout);
    assert.equal(second.migrated, false, 'a rerun writes nothing');
    assert.equal(second.disposition, 'already_migrated');
    assert.equal(second.currentKeyState, 'present');
    assert.equal(second.currentKeyId, material.keyId);
  });
});

describe('C12R-R2-F3 superseded identities report a locatable digest', () => {
  it('reports the current digest even with no state at all', async () => {
    const fx = identityFixture('digest-none');
    const report = JSON.parse((await runActivation(fx, ['identity-status', '--json'])).stdout);
    assert.equal(report.currentDigest, repositoryAuthorityDigest(fx.currentIdentity));
    assert.equal(report.currentKeyState, 'missing');
    assert.ok(Array.isArray(report.supersededIdentities));
    const text = await runActivation(fx, ['identity-status']);
    assert.match(text.stdout, /digest:/, 'the current identity digest is always shown');
    if (!fx.hasSupersededSpellings) assert.match(text.stdout, /superseded:\s+\(none\)/);
  });

  it('gives every superseded identity the digest that names its revocation directory', async function () {
    const fx = identityFixture('digest-many');
    if (!fx.hasSupersededSpellings) { this.skip(); return; }
    assert.ok(fx.legacyIdentities.length >= 1);
    const report = JSON.parse((await runActivation(fx, ['identity-status', '--json'])).stdout);
    assert.equal(report.supersededIdentities.length, fx.legacyIdentities.length);
    for (const item of report.supersededIdentities) {
      assert.ok(item.digest, `superseded identity ${item.identity} reports no digest`);
      assert.equal(item.digest, repositoryAuthorityDigest(item.identity));
      // The documented manual repair reads
      // `<root>/revocations/<identity-digest>/`, so the reported directory must
      // actually resolve from the reported digest.
      assert.ok(
        String(item.revocationDirectory).replace(/\\/g, '/').endsWith(`/revocations/${item.digest}`),
        `${item.revocationDirectory} does not resolve from digest ${item.digest}`
      );
    }
  });

  it('shows the digest in human-readable output too', async function () {
    const fx = identityFixture('digest-text');
    if (!fx.hasSupersededSpellings) { this.skip(); return; }
    const json = JSON.parse((await runActivation(fx, ['identity-status', '--json'])).stdout);
    const text = await runActivation(fx, ['identity-status']);
    assert.match(text.stdout, new RegExp(`digest:\\s+${json.currentDigest}`));
    for (const item of json.supersededIdentities) {
      assert.ok(
        text.stdout.includes(item.digest),
        `superseded digest ${item.digest} is absent from human-readable output`
      );
      assert.ok(
        text.stdout.includes(item.revocationDirectory),
        `superseded revocation directory is absent from human-readable output`
      );
    }
  });

  it('reports a malformed superseded key without losing its digest', async function () {
    const fx = identityFixture('digest-malformed');
    if (!fx.hasSupersededSpellings) { this.skip(); return; }
    const path = operatorActivationKeyPathForIdentity(fx.legacyIdentities[0], fx.operatorActivationRoot);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');
    const report = JSON.parse((await runActivation(fx, ['identity-status', '--json'])).stdout);
    assert.equal(report.disposition, 'conflict');
    const malformed = report.supersededIdentities.find(item => item.keyState === 'malformed');
    assert.ok(malformed, 'an unreadable superseded key is reported, not skipped');
    assert.equal(malformed.digest, repositoryAuthorityDigest(malformed.identity));
  });

  it('reports several superseded identities each with its own digest', async function () {
    const fx = identityFixture('digest-several');
    if (fx.legacyIdentities.length < 2) { this.skip(); return; }
    const report = JSON.parse((await runActivation(fx, ['identity-status', '--json'])).stdout);
    const digests = report.supersededIdentities.map(item => item.digest);
    assert.equal(new Set(digests).size, digests.length, 'each spelling has its own storage digest');
  });

  it('derives a stable digest for Windows casing variants of one identity', () => {
    // Casing is exactly what the v1 to v2 change folded, so the digest the
    // operator is told to look under must be a function of the identity string
    // and nothing else - including on a case-insensitive filesystem.
    const lower = repositoryAuthorityDigest('file:c:/apps/repo');
    assert.equal(repositoryAuthorityDigest('file:c:/apps/repo'), lower);
    assert.notEqual(repositoryAuthorityDigest('file:C:/Apps/Repo'), lower);
    assert.match(lower, /^[a-f0-9]{16,}$/);
  });
});

// ── C12R-R2-F4 ────────────────────────────────────────────────────────────────

describe('C12R-R2-F4 the key reader proves membership beneath its root', () => {
  function keyFixture(name) {
    const root = mkdtempSync(join(temp, `${name}-`));
    const target = join(root, 'target');
    const operatorRoot = join(root, 'operator');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(target, { recursive: true });
    mkdirSync(operatorRoot, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    return { root, target, operatorRoot, elsewhere, identity: targetRepositoryIdentity(target) };
  }

  function writeDocument(path, identity) {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, renderOperatorActivationKeyDocument({
      repositoryIdentity: identity,
      ...keyMaterial(),
    }), 'utf8');
    return path;
  }

  it('accepts a valid document stored below the configured root', () => {
    const fx = keyFixture('reader-valid');
    const path = operatorActivationKeyPathForIdentity(fx.identity, fx.operatorRoot);
    writeDocument(path, fx.identity);
    const read = readOperatorActivationKeyDocument(path, fx.identity, {
      target: fx.target,
      root: fx.operatorRoot,
    });
    assert.equal(read.state, 'present', read.errors.join('; '));
    assert.equal(read.ok, true);
  });

  it('refuses a document outside the configured root even when it is outside the target', () => {
    // The residual defect: this document satisfies "not inside the repository"
    // and used to be accepted as operator material on that basis alone.
    const fx = keyFixture('reader-outside');
    const path = writeDocument(join(fx.elsewhere, 'planted.json'), fx.identity);
    const read = readOperatorActivationKeyDocument(path, fx.identity, {
      target: fx.target,
      root: fx.operatorRoot,
    });
    assert.equal(read.ok, false, 'a document outside the operator root is never operator material');
    assert.equal(read.state, 'malformed');
    assert.match(read.errors.join('; '), /operator activation root/);
  });

  it('refuses a parent-traversal path that leaves the root', () => {
    const fx = keyFixture('reader-traversal');
    const path = writeDocument(join(fx.elsewhere, 'planted.json'), fx.identity);
    const traversal = join(fx.operatorRoot, '..', 'elsewhere', 'planted.json');
    const read = readOperatorActivationKeyDocument(traversal, fx.identity, {
      target: fx.target,
      root: fx.operatorRoot,
    });
    assert.equal(read.ok, false, `traversal to ${path} must not be accepted`);
    assert.equal(read.state, 'malformed');
  });

  it('refuses a link that escapes the root', function () {
    const fx = keyFixture('reader-link');
    writeDocument(join(fx.elsewhere, 'planted.json'), fx.identity);
    const linkPath = join(fx.operatorRoot, 'linked.json');
    try {
      symlinkSync(join(fx.elsewhere, 'planted.json'), linkPath, 'file');
    } catch {
      // Unprivileged Windows hosts cannot create symbolic links. The lexical
      // and realpath assertions above still hold there; skipping is honest
      // rather than pretending this platform exercised the link case.
      this.skip();
      return;
    }
    const read = readOperatorActivationKeyDocument(linkPath, fx.identity, {
      target: fx.target,
      root: fx.operatorRoot,
    });
    assert.equal(read.ok, false, 'a symbolic link is never read as operator material');
    assert.equal(read.state, 'malformed');
  });

  it('still refuses a root or document inside the target repository', () => {
    const fx = keyFixture('reader-inside');
    const insideRoot = join(fx.target, 'operator');
    const insidePath = operatorActivationKeyPathForIdentity(fx.identity, insideRoot);
    writeDocument(insidePath, fx.identity);
    const read = readOperatorActivationKeyDocument(insidePath, fx.identity, {
      target: fx.target,
      root: insideRoot,
    });
    assert.equal(read.ok, false);
    assert.match(read.errors.join('; '), /outside the target repository/);
  });

  it('still refuses a document bound to another repository identity', () => {
    const fx = keyFixture('reader-identity');
    const path = operatorActivationKeyPathForIdentity(fx.identity, fx.operatorRoot);
    writeDocument(path, 'file:/some/other/repository');
    const read = readOperatorActivationKeyDocument(path, fx.identity, {
      target: fx.target,
      root: fx.operatorRoot,
    });
    assert.equal(read.ok, false);
    assert.match(read.errors.join('; '), /does not match this repository/);
  });

  it('reports a missing document below the root as missing, not malformed', () => {
    const fx = keyFixture('reader-missing');
    const path = operatorActivationKeyPathForIdentity(fx.identity, fx.operatorRoot);
    const read = readOperatorActivationKeyDocument(path, fx.identity, {
      target: fx.target,
      root: fx.operatorRoot,
    });
    assert.equal(read.state, 'missing');
    assert.equal(read.ok, true);
  });

  it('keeps the derived-path loader inside the same boundary', () => {
    const fx = keyFixture('loader-boundary');
    const path = operatorActivationKeyPathForIdentity(fx.identity, fx.operatorRoot);
    writeDocument(path, fx.identity);
    const loaded = loadOperatorActivationKey(fx.target, { operatorActivationRoot: fx.operatorRoot });
    assert.equal(loaded.state, 'present', loaded.errors.join('; '));
    const insideTarget = loadOperatorActivationKey(fx.target, {
      operatorActivationRoot: join(fx.target, 'operator'),
    });
    assert.equal(insideTarget.ok, false);
  });
});
