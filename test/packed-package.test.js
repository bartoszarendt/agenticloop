/**
 * Packed-package smoke tests.
 *
 * Builds a real `npm pack` archive once, installs it into an isolated prefix,
 * and proves the shipped binary reports the package version, renders complete
 * help, ships docs/cli-reference.md, runs setup dry-run with zero writes, and
 * retains the direct init path — so the documented CLI contract cannot be
 * omitted from the published package.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, delimiter, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createDispatchFixture,
  git,
  readyReturn,
  repositoryEvidence,
} from './helpers/dispatch-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpBase;
let packedBin;
let packedRoot;

function npm(args, options = {}) {
  return spawnSync('npm', args, {
    encoding: 'utf-8',
    shell: true,
    env: { ...process.env, npm_config_cache: join(tmpBase, 'npm-cache') },
    ...options,
  });
}

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-packed-'));
  const packDir = join(tmpBase, 'pack');
  mkdirSync(packDir, { recursive: true });
  let archivePath;
  if (process.env.AGENTICLOOP_TEST_ARCHIVE) {
    archivePath = resolve(REPO_ROOT, process.env.AGENTICLOOP_TEST_ARCHIVE);
    assert.ok(existsSync(archivePath), `requested archive is missing: ${archivePath}`);
  } else {
    const packed = npm(['pack', '--pack-destination', packDir], { cwd: REPO_ROOT });
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stdout}\n${packed.stderr}`);
    const tarball = readdirSync(packDir).find(entry => entry.endsWith('.tgz'));
    assert.ok(tarball, 'npm pack must produce a tarball');
    archivePath = join(packDir, tarball);
  }

  const prefix = join(tmpBase, 'prefix');
  const installed = npm(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', archivePath]);
  assert.equal(installed.status, 0, `npm install failed:\n${installed.stdout}\n${installed.stderr}`);
  packedRoot = join(prefix, 'node_modules', 'agenticloop');
  packedBin = join(packedRoot, 'bin', 'agenticloop.js');
  assert.ok(existsSync(packedBin), `packed binary missing at ${packedBin}`);
}, { timeout: 300000 });

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function runPacked(args, options = {}) {
  return spawnSync(process.execPath, [packedBin, ...args], { encoding: 'utf-8', ...options });
}

function runPackedWithHostContext(args, operatorTrustRoot) {
  const wrapper = join(tmpBase, 'packed-host-wrapper.mjs');
  if (!existsSync(wrapper)) {
    writeFileSync(wrapper, [
      `import { runCli } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'cli-main.js')).href)};`,
      'process.exitCode = await runCli(JSON.parse(process.env.AGENTICLOOP_TEST_ARGS), {',
      '  operatorTrustRoot: process.env.AGENTICLOOP_TEST_OPERATOR_ROOT,',
      '});',
      '',
    ].join('\n'), 'utf8');
  }
  return spawnSync(process.execPath, [wrapper], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTICLOOP_TEST_ARGS: JSON.stringify(args),
      AGENTICLOOP_TEST_OPERATOR_ROOT: operatorTrustRoot,
    },
  });
}

/**
 * Read-only fake `gh` responder shared by the PATH shim. It runs either as the
 * shim's main script (POSIX) or as a NODE_OPTIONS preload inside a renamed
 * node binary (Windows, where spawnSync cannot execute .cmd shims).
 */
const FAKE_GH_RESPONDER = `
const fs = require('fs');
const path = require('path');
const isMain = require.main === module;
const isGhBinary = /gh(\\.exe)?$/i.test(path.basename(process.execPath));
if (isMain || isGhBinary) {
  const args = process.argv.slice(isMain ? 2 : 1);
  if (!isMain && args.length > 0 && path.isAbsolute(args[0])) args[0] = path.basename(args[0]);
  if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
  const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));
  const out = value => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
  const fail = message => { process.stderr.write(message); process.exit(1); };
  if (args[0] === 'pr' && args[1] === 'view') out(fx.prData);
  if (args[0] === 'issue' && args[1] === 'list') out(fx.issues || []);
  if (args[0] === 'issue' && args[1] === 'view') out(fx.issueData);
  if (args[0] === 'repo' && args[1] === 'view') out({ nameWithOwner: fx.repo });
  if (args[0] === 'api') {
    if (args[1] === 'user') out(fx.account);
    const endpoint = args.find(item => typeof item === 'string' && item.startsWith('repos/')) || '';
    if (endpoint.includes('/issues/') && endpoint.includes('/comments')) {
      const number = Number((endpoint.match(/issues\\/(\\d+)\\/comments/) || [])[1]);
      out([number === fx.issueData.number ? fx.issueComments : []]);
    }
    if (endpoint.includes('/pulls/') && endpoint.includes('/reviews')) out([[]]);
    if (endpoint.includes('/git/trees/')) out({ tree: fx.baseTree || [], truncated: false });
    fail('unexpected endpoint ' + endpoint);
  }
  fail('unexpected gh command: ' + args.join(' '));
}
`;

/** Install a PATH-shimmed read-only fake `gh` and return the env additions. */
function installFakeGh(tmpBase, fixture) {
  const shimRoot = mkdtempSync(join(tmpBase, 'fake gh-'));
  const fakeBin = join(shimRoot, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const fixturePath = join(shimRoot, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');
  const logPath = join(shimRoot, 'invocations.log');
  const env = {
    ...process.env,
    FAKE_GH_FIXTURE: fixturePath,
    FAKE_GH_LOG: logPath,
  };
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(fakeBin, 'gh.exe'));
    const preload = join(shimRoot, 'fake-gh.cjs');
    writeFileSync(preload, FAKE_GH_RESPONDER, 'utf8');
    const preloadOption = preload.replace(/\\/g, '/').replaceAll('"', '\\"');
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require="${preloadOption}"`.trim();
  } else {
    const responder = join(shimRoot, 'fake-gh.cjs');
    writeFileSync(responder, FAKE_GH_RESPONDER, 'utf8');
    const script = join(fakeBin, 'gh');
    writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${responder}" "$@"\n`, 'utf8');
    chmodSync(script, 0o755);
  }
  env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
  return { env, logPath };
}

function readGhInvocations(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function assertReadOnlyGhInvocations(invocations) {
  const allowedVerbs = new Set(['pr view', 'issue view', 'repo view']);
  const writeApiFlags = new Set(['--method', '-X', '--input', '--field', '-F', '--raw-field', '-f']);
  for (const args of invocations) {
    const verb = `${args[0] ?? ''} ${args[1] ?? ''}`;
    if (args[0] === 'api') {
      assert.ok(!args.some(arg => writeApiFlags.has(arg)), `GitHub API write option invoked: gh ${args.join(' ')}`);
      continue;
    }
    assert.ok(allowedVerbs.has(verb), `non-read GitHub command invoked: gh ${args.join(' ')}`);
  }
}

describe('packed package smoke tests', () => {
  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    for (const args of [['--version'], ['version']]) {
      const result = runPacked(args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`agenticloop ${pkg.version.replaceAll('.', '\\.')}`));
    }
  });

  it('ships fixed-root host trust that rejects supported stores and caller-selected roots', async () => {
    const trustModule = await import(pathToFileURL(join(packedRoot, 'src', 'host-trust.js')).href);
    const target = mkdtempSync(join(tmpBase, 'packed-trust-target-'));
    const operatorRoot = mkdtempSync(join(tmpBase, 'packed-operator-root-'));
    const attackerRoot = mkdtempSync(join(tmpBase, 'packed-attacker-root-'));
    const { publicKeyBase64 } = trustModule.generateHostSigningKey();
    const document = {
      kind: 'agenticloop.host-trust',
      schemaVersion: 1,
      target: { repositoryIdentity: trustModule.targetRepositoryIdentity(target) },
      adapters: [{
        adapterId: 'packed.parser.v1',
        keyId: 'packed-key-1',
        algorithm: 'ed25519',
        publicKey: publicKeyBase64,
        capabilities: { activationCapture: 'supported', returnReceipt: 'supported' },
      }],
    };
    const operatorPath = trustModule.operatorTrustStorePath(target, operatorRoot);
    const attackerPath = trustModule.operatorTrustStorePath(target, attackerRoot);
    mkdirSync(dirname(operatorPath), { recursive: true });
    mkdirSync(dirname(attackerPath), { recursive: true });
    writeFileSync(operatorPath, `${JSON.stringify(document)}\n`, 'utf8');
    writeFileSync(attackerPath, `${JSON.stringify(document)}\n`, 'utf8');

    const unsupported = trustModule.loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: operatorPath,
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.state, 'unsupported_boundary');
    assert.match(unsupported.errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
    const rejected = trustModule.loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: attackerPath,
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /does not match the pre-registered operator trust path/);
  });

  it('keeps installed public dispatch fail-closed for a caller-supplied supported registry', async () => {
    const fixture = await createDispatchFixture(tmpBase, 'packed-dispatch');
    writeFileSync(
      join(fixture.root, 'dispatch-input.json'),
      JSON.stringify({
        readiness: fixture.readiness,
        decomposition: fixture.decomposition,
        assignment: fixture.assignment,
      }),
      'utf8'
    );
    const prepared = runPackedWithHostContext([
      'task', 'prepare-dispatch', 'T-001',
      '--input', 'dispatch-input.json',
      '--host-trust-store', fixture.trustStorePath,
      '--json',
      '--target', fixture.root,
    ], fixture.operatorTrustRoot);
    assert.equal(prepared.status, 1);
    const result = JSON.parse(prepared.stdout);
    assert.equal(result.disposition, 'blocked');
    assert.match(result.errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
  });

  it('exercises installed corrective capture, drift, diagnostic, and required-check contracts', async () => {
    const dispatch = await import(pathToFileURL(join(packedRoot, 'src', 'dispatch-envelope.js')).href);
    const handoff = await import(pathToFileURL(join(packedRoot, 'src', 'host-handoff.js')).href);
    const checks = await import(pathToFileURL(join(packedRoot, 'src', 'required-checks.js')).href);
    const taskEvidence = await import(pathToFileURL(join(packedRoot, 'src', 'task-evidence-contract.js')).href);
    const fixture = await createDispatchFixture(tmpBase, 'packed-corrective-contracts');
    const prepared = dispatch.prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));

    const digest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
    const provider = (packet, roleReturn, evidence) => {
      const producerReceipt = handoff.createHostHandoffReceipt({
        adapterId: fixture.trust.adapterId,
        keyId: fixture.trust.keyId,
        packet,
        roleReturn,
        repositoryEvidence: evidence,
      }, fixture.trust.privateKey);
      return { producerReceipt, resolveTrustedAdapter: () => fixture.trust.adapter };
    };

    const changedBody = `${fixture.snapshot().body}\n`;
    const changedSnapshot = { ...fixture.snapshot(), body: changedBody, digest: digest(changedBody) };
    const staleEvidence = repositoryEvidence(prepared.packet);
    staleEvidence.task.digest = changedSnapshot.digest;
    const staleReturnDraft = structuredClone(readyReturn(prepared.packet, staleEvidence));
    staleReturnDraft.task.digest = changedSnapshot.digest;
    const staleReturn = dispatch.createRoleReturn(staleReturnDraft);
    const stale = dispatch.receiveRoleReturn({
      raw: JSON.stringify(staleReturn),
      packet: prepared.packet,
      refetchTask: () => changedSnapshot,
      refetchRepositoryEvidence: () => staleEvidence,
      ...provider(prepared.packet, staleReturn, staleEvidence),
    }, fixture.options);
    assert.equal(stale.ok, false);
    assert.match(stale.validation.errors.join('\n'), /authoritative task and contract/);

    const recomputed = structuredClone(prepared.packet);
    recomputed.task.scope += '\nrecomputed packet attack';
    recomputed.digest = dispatch.dispatchPreparationDigest(recomputed);
    const recomputedEvidence = repositoryEvidence(recomputed);
    const recomputedReturn = readyReturn(recomputed, recomputedEvidence);
    const recomputedResult = dispatch.receiveRoleReturn({
      raw: JSON.stringify(recomputedReturn),
      packet: recomputed,
      refetchTask: fixture.snapshot,
      refetchRepositoryEvidence: () => recomputedEvidence,
      ...provider(recomputed, recomputedReturn, recomputedEvidence),
    }, fixture.options);
    assert.equal(recomputedResult.ok, false);
    assert.match(recomputedResult.validation.errors.join('\n'), /authoritative task and contract/);

    const githubSnapshot = { ...fixture.snapshot(), backend: 'github', carrier: 'issue:42' };
    const githubReadiness = {
      ...fixture.readiness,
      evidence: taskEvidence.createTaskReadinessEvidence({
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
    const githubPrepared = dispatch.prepareRoleDispatch(githubFixture, fixture.options);
    assert.equal(githubPrepared.ok, true, githubPrepared.validation.errors?.join('\n'));
    const githubAttack = structuredClone(githubPrepared.packet);
    githubAttack.task.scope += '\nrecomputed GitHub packet attack';
    githubAttack.digest = dispatch.dispatchPreparationDigest(githubAttack);
    const githubEvidence = repositoryEvidence(githubAttack, {
      pr: { state: 'open', number: 42, url: 'https://example.test/pull/42' },
    });
    const githubReturn = readyReturn(githubAttack, githubEvidence);
    const githubRejected = dispatch.receiveRoleReturn({
      raw: JSON.stringify(githubReturn),
      packet: githubAttack,
      refetchTask: () => githubSnapshot,
      refetchRepositoryEvidence: () => githubEvidence,
      ...provider(githubAttack, githubReturn, githubEvidence),
    }, fixture.options);
    assert.equal(githubRejected.ok, false);
    assert.match(githubRejected.validation.errors.join('\n'), /authoritative task and contract/);

    const replay = dispatch.activationCaptureDisposition(fixture.activation, {
      ...fixture.options,
      intendedTaskId: 'T-002',
      repositoryIdentity: fixture.trust.adapter.repositoryIdentity,
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.evidenceState, 'changed');

    const capturedAt = new Date(Date.now() - 7_200_000).toISOString();
    const expiresAt = new Date(Date.now() - 3_600_000).toISOString();
    const expiredCapture = dispatch.captureActivationInput({
      adapter: fixture.trust.adapterId,
      intendedTaskId: 'T-001',
      expectedRequestSha256: digest('expired installed capture'),
      parserNormalizedPayload: 'expired installed capture',
      capturedAt,
      expiresAt,
      sign: { keyId: fixture.trust.keyId, privateKey: fixture.trust.privateKey },
    }, fixture.options);
    const expired = dispatch.activationCaptureDisposition(expiredCapture, {
      ...fixture.options,
      intendedTaskId: 'T-001',
      repositoryIdentity: fixture.trust.adapter.repositoryIdentity,
    });
    assert.equal(expired.ok, false);
    assert.match(expired.errors.join('\n'), /expired/);

    for (const adapter of Object.keys(dispatch.SHIPPED_ACTIVATION_ADAPTERS)) {
      const unsupported = dispatch.captureActivationInput({ adapter });
      const disposition = dispatch.activationCaptureDisposition(unsupported);
      assert.equal(disposition.evidenceState, 'negative', adapter);
      assert.equal(disposition.disposition, 'blocked', adapter);
    }

    const multi = dispatch.receiveRoleReturn({ raw: '{}', packet: prepared.packet }, fixture.options);
    assert.equal(multi.ok, false);
    assert.equal(multi.validation.diagnostics.length, 1);
    assert.match(multi.validation.diagnostics[0].message, /missing field/);
    assert.deepEqual(multi.validation.errors, multi.validation.diagnostics.map(item => item.message));

    const inventory = checks.parseRequiredCheckInventory([
      '- [RC-2] manual: Inspect the installed adapter capability output',
      '- [RC-1] command: `npm test`',
    ].join('\n'));
    assert.equal(inventory.ok, true, inventory.errors?.join('\n'));
    const evidence = [
      { id: 'RC-2', kind: 'manual', instruction: 'Inspect the installed adapter capability output', outcome: 'passed', exitCode: null, evidence: 'inspected' },
      { id: 'RC-1', kind: 'command', command: 'npm test', outcome: 'passed', exitCode: 0, evidence: 'passed' },
    ];
    assert.equal(checks.requiredCheckEvidenceMatchesInventory(evidence, inventory.checks), false);
    assert.equal(checks.requiredCheckEvidenceMatchesInventory([...evidence].reverse(), inventory.checks), true);
  });

  it('renders complete help and first-use guidance', () => {
    const help = runPacked(['help']);
    assert.equal(help.status, 0, help.stderr);
    for (const command of ['setup', 'init', 'doctor', 'update', 'remove', 'task', 'audit', 'worktree']) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, 'm'), `complete help must list '${command}'`);
    }
    for (const command of ['pr-body', 'task-readiness', 'commit-attribution', 'github-checkpoint', 'github-review-prepare']) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, 'm'), `complete help must list review-preparation command '${command}'`);
    }
    const bare = runPacked([]);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /agenticloop setup/);
    const commandHelp = runPacked(['setup', '--help']);
    assert.equal(commandHelp.status, 0);
    assert.match(commandHelp.stdout, /--non-interactive/);
    assert.match(commandHelp.stdout, /--dry-run/);
  });

  it('renders --help for every review-preparation command from the installed tarball', () => {
    for (const [command, sub] of [['pr-body', 'scaffold'], ['pr-body', 'lint'], ['task-readiness', null], ['commit-attribution', 'check'], ['github-checkpoint', 'render'], ['github-checkpoint', 'repair-plan'], ['github-review-prepare', null], ['github-preflight', null], ['github-review-audit', null], ['github-ready', null]]) {
      const args = sub ? [command, sub, '--help'] : [command, '--help'];
      const result = runPacked(args);
      assert.equal(result.status, 0, `${args.join(' ')} --help failed:\n${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.length > 0, `${command} --help must render text`);
    }
  });

  it('runs task-readiness with --task-body and --base-paths from the installed tarball', () => {
    const target = mkdtempSync(join(tmpBase, 'readiness-'));
    const readinessRecord = allowedPath => [
      '---', `allowed_paths: ["${allowedPath}"]`, '---', '# Task',
      '## Task', 'Evaluate readiness.',
      '## Source Documents Reviewed', '- README.md',
      '## Current State', 'Awaiting evaluation.',
      '## Scope', 'Check the declared path.',
      '## Out of Scope', 'No implementation.',
      '## Acceptance Criteria', '- Readiness is reported.',
      '## Required Checks', '- task-readiness',
      '## Expected Files or Areas', `- ${allowedPath}`,
      '## Implementation Notes', 'Use the packed command.',
      '## Completion Summary Template', 'Summarize readiness.',
      '## Reviewer Checklist', '- [ ] Verify the result.',
    ].join('\n');
    const taskFile = join(target, 'task.md');
    writeFileSync(taskFile, readinessRecord('src/**'), 'utf-8');
    const baseFile = join(target, 'base.json');
    writeFileSync(baseFile, JSON.stringify(['src/app.js']), 'utf-8');
    const ok = runPacked(['task-readiness', '--task-body', taskFile, '--base-paths', baseFile, '--mode', 'review', '--json'], { cwd: target });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.equal(JSON.parse(ok.stdout).ok, true);
    const typo = join(target, 'task-typo.md');
    writeFileSync(typo, readinessRecord('src/app/App.tsx'), 'utf-8');
    const bad = runPacked(['task-readiness', '--task-body', typo, '--base-paths', baseFile, '--mode', 'review', '--json'], { cwd: target });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(JSON.parse(bad.stdout).errors.join('\n'), /App\.tsx/);
  });

  it('fails GitHub handlers safely before any network access on missing input', () => {
    for (const args of [
      ['github-preflight', '--json'],
      ['github-review-prepare', '--json'],
      ['github-checkpoint', 'render', '--json'],
      ['github-checkpoint', 'repair-plan', '--json'],
      ['pr-body', 'scaffold', '--json'],
    ]) {
      const result = runPacked(args);
      assert.equal(result.status, 2, `${args.join(' ')} must exit 2 on missing input:\n${result.stdout}\n${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false, `${args.join(' ')} must return a failure envelope`);
      assert.match(parsed.errors.join('\n'), /--pr|--issue|required/i, `${args.join(' ')} must name the missing input`);
    }
  });

  it('runs commit-attribution check read-only from the installed tarball and never amends', () => {
    const target = mkdtempSync(join(tmpBase, 'attr-'));
    const messageFile = join(target, 'message.txt');
    writeFileSync(messageFile, 'subject\n\nTask: T-007\nAgent: maintainer\nTask: T-007', 'utf-8');
    const result = runPacked(['commit-attribution', 'check', '--task', 'T-007', '--message-file', messageFile, '--json', '--target', target], { cwd: target });
    // Failing attribution returns a nonzero gate result with a repair plan.
    assert.notEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.repairPlan, /Task: T-007/);
    assert.match(parsed.repairPlan, /Agent: engineer/);
    assert.ok(!/git commit --amend|git push|--force/i.test(parsed.repairPlan), 'repair plan must never amend or push');
    // The message file is unchanged: the command is strictly read-only.
    assert.equal(readFileSync(messageFile, 'utf-8'), 'subject\n\nTask: T-007\nAgent: maintainer\nTask: T-007');
  });

  it('runs pr-body lint offline from the installed tarball', () => {
    const target = mkdtempSync(join(tmpBase, 'lint-'));
    const HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const input = {
      schemaVersion: 1,
      prData: { number: 1, body: '## Scope Completed\nREPLACE: x\n\n## Evidence\nCurrent PR head: ' + HEAD_SHA + '\n', headRefOid: HEAD_SHA, baseRefOid: 'b'.repeat(40), files: [], statusCheckRollup: [], commits: [], comments: [], reviews: [] },
      issueData: { number: 2, body: '---\ntask_id: T-1\n---\n# T\n', comments: [] },
      expectedAccount: { login: 'bot' }, reviewHistory: { events: [], errors: [] },
      basePaths: [], mode: 'review', projectFacts: [], references: { decisionIds: [], taskIds: [] },
      verificationStatus: null, configuration: { reviewBudget: 5, reviewBudgetError: null, projectMapConfig: null },
      pathInventoryRequired: true,
    };
    const inputFile = join(target, 'input.json');
    writeFileSync(inputFile, JSON.stringify(input), 'utf-8');
    const result = runPacked(['pr-body', 'lint', '--input', inputFile, '--json'], { cwd: target });
    // A scaffold containing REPLACE must fail lint; it never performs network access.
    assert.notEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.lintReady, false);
    assert.match(parsed.errors.join('\n'), /placeholder/i);
  });

  it('completes the scaffold-edit-lint workflow from the installed tarball with a PATH-shimmed fake gh', { timeout: 120000 }, () => {
    const HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const BASE_SHA = 'b'.repeat(40);
    const fixture = {
      prData: {
        number: 7,
        body: 'stale remote draft that was never updated',
        baseRefOid: BASE_SHA,
        headRefOid: HEAD_SHA,
        files: [],
        closingIssuesReferences: [{ number: 3 }],
        statusCheckRollup: [],
        commits: [{ oid: HEAD_SHA, message: 'implement T-007\n\nTask: T-007\nAgent: engineer' }],
        comments: [],
        reviews: [],
      },
      issueData: {
        number: 3,
        title: 'T-007 sample',
        body: '---\ntask_id: T-007\n---\n# T-007 Sample\n\n## Required Checks\n- [RC-1] `npm test`\n',
        comments: [],
      },
      issueComments: [],
      repo: 'octo/repo',
      account: { login: 'loop-bot', type: 'User' },
    };
    const target = mkdtempSync(join(tmpBase, 'pr-body-flow-'));
    const { env, logPath } = installFakeGh(tmpBase, fixture);

    // 1. Scaffold the body and the context snapshot through the fake gh.
    const scaffold = runPacked(
      ['pr-body', 'scaffold', '--pr', '7', '--output', 'body.md', '--snapshot-output', 'ctx.snapshot.json', '--json'],
      { cwd: target, env },
    );
    assert.equal(scaffold.status, 0, scaffold.stderr + scaffold.stdout);
    const scaffoldResult = JSON.parse(scaffold.stdout);
    assert.equal(scaffoldResult.nextCommand, 'npx agenticloop pr-body lint --pr 7 --body-file body.md');
    const bodyPath = join(target, 'body.md');
    const snapshotPath = join(target, 'ctx.snapshot.json');
    assert.ok(existsSync(bodyPath));
    assert.ok(existsSync(snapshotPath));
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.equal(snapshot.kind, 'agenticloop.pr-body-context');
    assert.equal(snapshot.snapshotSchemaVersion, 1);
    assert.equal(snapshot.head, HEAD_SHA);
    assert.equal(snapshot.repository, 'octo/repo');

    // 2. The scaffolded placeholder body fails offline lint without any gh on PATH.
    const plainEnv = { ...process.env };
    delete plainEnv.NODE_OPTIONS;
    const placeholder = runPacked(['pr-body', 'lint', '--snapshot', 'ctx.snapshot.json', '--body-file', 'body.md', '--json'], { cwd: target, env: plainEnv });
    assert.equal(placeholder.status, 1, placeholder.stderr);
    assert.match(JSON.parse(placeholder.stdout).errors.join('\n'), /placeholder/i);

    // 3. Engineer edits the Markdown draft locally.
    writeFileSync(bodyPath, [
      '## Scope Completed', 'Completed the scoped change.', '',
      '## Artifacts', `Current implementation artifact: commit:${HEAD_SHA}`, '',
      '## Evidence', `Current PR head: ${HEAD_SHA}`, '',
      '- Required check: [RC-1] `npm test`', '  Verdict: passed', '  Evidence: 47 tests passed (exit 0)', '',
      '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.', '',
      '[[agent: engineer]]',
    ].join('\n'), 'utf8');

    // 4. Offline snapshot lint passes with zero network access (no shim on PATH).
    const offline = runPacked(['pr-body', 'lint', '--snapshot', 'ctx.snapshot.json', '--body-file', 'body.md', '--json'], { cwd: target, env: plainEnv });
    assert.equal(offline.status, 0, offline.stderr + offline.stdout);
    const offlineResult = JSON.parse(offline.stdout);
    assert.equal(offlineResult.contextMode, 'snapshot');
    assert.equal(offlineResult.publicationReady, true);

    // 5. Live-context lint evaluates the local draft, not the stale remote body.
    const live = runPacked(['pr-body', 'lint', '--pr', '7', '--body-file', 'body.md', '--json'], { cwd: target, env });
    assert.equal(live.status, 0, live.stderr + live.stdout);
    const liveResult = JSON.parse(live.stdout);
    assert.equal(liveResult.contextMode, 'live');
    assert.equal(liveResult.publicationReady, true);
    assert.equal(liveResult.headRefOid, HEAD_SHA);

    // 6. Every fake-gh invocation was read-only; no write command ran.
    const invocations = readGhInvocations(logPath);
    assert.ok(invocations.length > 0, 'live modes must read GitHub context through gh');
    assertReadOnlyGhInvocations(invocations);
  });

  /**
   * The packed archive ships both live Claude Code activation surfaces and the
   * Copilot IDE prompt fallback. Each must carry its own typed declaration in
   * the installed artifact, not only in the repository source.
   */
  it('ships every activation surface with a typed unsupported declaration', async () => {
    const slots = await import(pathToFileURL(join(packedRoot, 'src', 'adapter-slots.js')).href);
    const frontmatter = await import(pathToFileURL(join(packedRoot, 'src', 'frontmatter.js')).href);

    // Claude Code Mode A: the command .claude-plugin/plugin.json registers.
    const manifest = JSON.parse(readFileSync(join(packedRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.ok(manifest.commands.includes('./commands/start.md'), 'packed plugin manifest must register ./commands/start.md');
    const [, startBody] = frontmatter.parseFrontmatter(readFileSync(join(packedRoot, 'commands', 'start.md'), 'utf8'));
    assert.deepEqual(
      slots.validateStaticPluginCommandSlots(startBody, 'commands/start.md', slots.CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID),
      [],
      'the packed Mode A command must carry the complete filled declaration'
    );
    assert.equal((startBody.match(/\$ARGUMENTS/g) ?? []).length, 1);
    assert.equal((startBody.match(/\$\d+/g) ?? []).length, 0);

    const target = mkdtempSync(join(tmpBase, 'packed-activation-'));
    const initialized = runPacked(['init', '--target', target, '--adapter', 'all']);
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);

    // Claude Code Mode B plus the Copilot skill and IDE prompt.
    for (const relPath of [
      '.claude/commands/agenticloop.md',
      '.claude/skills/agenticloop/SKILL.md',
      '.github/skills/agenticloop/SKILL.md',
      '.github/prompts/agenticloop.prompt.md',
    ]) {
      const path = join(target, ...relPath.split('/'));
      assert.ok(existsSync(path), `packed init must write ${relPath}`);
      const text = readFileSync(path, 'utf8');
      for (const slotId of slots.ADAPTER_SLOT_IDS) {
        const open = text.split(`<!-- AGENTICLOOP_ADAPTER_SLOT:${slotId} -->`).length - 1;
        assert.equal(open, 1, `${relPath} must open slot '${slotId}' exactly once`);
        assert.ok(slots.locateAdapterSlot(text, slotId).inner.trim(), `${relPath} slot '${slotId}' must be non-empty`);
      }
      assert.match(text, /Activation capture capability: `unsupported`\./, relPath);
      assert.match(text, /advisory/i, relPath);
      assert.doesNotMatch(text, /\$ARGUMENTS|\$1|\$2/, relPath);
      assert.deepEqual(slots.validateFilledAdapterSlots(text, relPath), [], relPath);
    }

    const prompt = readFileSync(join(target, '.github', 'prompts', 'agenticloop.prompt.md'), 'utf8');
    assert.match(prompt, /Activation adapter: `copilot\.prompt\.input\.v1`\./);
    assert.match(prompt, /advisory only/i);
    assert.match(prompt, /never be serialized as activation proof/i);

    const validated = runPacked(['validate', '--target', target]);
    assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
  });

  it('ships docs/cli-reference.md', () => {
    assert.ok(existsSync(join(packedRoot, 'docs', 'cli-reference.md')),
      'docs/cli-reference.md must be shipped in the packed package');
  });

  it('ships the runtime transition module in the package', () => {
    assert.ok(existsSync(join(packedRoot, 'src', 'transition-contract.js')),
      'src/transition-contract.js must be shipped in the packed package');
  });

  it('runs setup --dry-run --json with zero writes from the packed package', () => {
    const target = mkdtempSync(join(tmpBase, 'target-'));
    const result = runPacked(['setup', '--target', target, '--adapter', 'opencode', '--dry-run', '--json']);
    // Unconfirmed profile: exit 1 with a valid versioned plan document.
    assert.equal(result.status, 1, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.command, 'setup');
    assert.ok(plan.blockers.length > 0);
    assert.deepEqual(readdirSync(target), [], 'setup dry-run must not write');
  });

  it('runs init --dry-run with zero writes from the packed package', () => {
    const target = mkdtempSync(join(tmpBase, 'target-'));
    const result = runPacked(['init', '--target', target, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Plan \(dry run/);
    assert.deepEqual(readdirSync(target), [], 'init dry-run must not write');
  });

  it('retains the direct init path for all five adapters', () => {
    for (const adapter of ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']) {
      const target = mkdtempSync(join(tmpBase, `target-${adapter}-`));
      const result = runPacked(['init', '--target', target, '--adapter', adapter]);
      assert.equal(result.status, 0, `${adapter}:\n${result.stdout}\n${result.stderr}`);
      assert.ok(existsSync(join(target, 'agenticloop.json')), `${adapter} must create agenticloop.json`);
      assert.ok(existsSync(join(target, 'agenticloop', 'manifest.json')), `${adapter} must scaffold the toolkit`);
    }
  });

  /**
   * The installed clean-fixture gate: for every adapter, install the packed
   * archive, initialize a fresh target, and validate it.
   *
   * `init` exiting 0 is not the contract downstream users experience - they run
   * `validate` next. Fresh atomic init renders adapter output from the package
   * source root while the target's `agenticloop/` exists only as pending
   * actions, so an adapter that resolves canonical assets with the wrong root
   * finds nothing, emits references to paths it never wrote, and only fails
   * here. Codex, Copilot, and Cursor each did exactly that.
   */
  it('initializes and validates a fresh installed target for all five adapters', { timeout: 300000 }, () => {
    const results = {};
    for (const adapter of ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']) {
      const target = mkdtempSync(join(tmpBase, `clean-fixture-${adapter}-`));
      const initialized = runPacked(['init', '--target', target, '--adapter', adapter]);
      const validated = runPacked(['validate', '--target', target]);
      const output = `${validated.stdout}\n${validated.stderr}`;
      results[adapter] = {
        init: initialized.status,
        validate: validated.status,
        errors: (output.match(/^\s*ERROR:/gm) ?? []).length,
        output,
      };
    }
    // Reported as one map so a partial regression names every failing adapter
    // instead of stopping at the first.
    for (const [adapter, result] of Object.entries(results)) {
      assert.equal(result.init, 0, `${adapter} init must succeed:\n${result.output}`);
      assert.equal(result.validate, 0, `${adapter} installed validate must succeed:\n${result.output}`);
      assert.equal(result.errors, 0, `${adapter} installed validate must report zero errors:\n${result.output}`);
      assert.doesNotMatch(result.output, /^\s*ERROR:/m, adapter);
    }
  });

  /**
   * Every adapter that renders backend references must actually write them.
   * Zero discovered backend entries produced a silently reference-free artifact
   * whose only symptom was a later validation error about dangling bare paths.
   */
  it('writes real backend references for every adapter that renders them', () => {
    const expectations = {
      codex: '.agents/skills/agenticloop',
      copilot: '.github/skills/agenticloop',
      cursor: '.cursor/skills/agenticloop',
    };
    for (const [adapter, skillDir] of Object.entries(expectations)) {
      const target = mkdtempSync(join(tmpBase, `backend-refs-${adapter}-`));
      const initialized = runPacked(['init', '--target', target, '--adapter', adapter]);
      assert.equal(initialized.status, 0, `${adapter}:\n${initialized.stdout}\n${initialized.stderr}`);
      const backendsDir = join(target, ...skillDir.split('/'), 'references', 'backends');
      for (const filename of ['README.md', 'files.md', 'github.md']) {
        const path = join(backendsDir, filename);
        assert.ok(existsSync(path), `${adapter} must write ${skillDir}/references/backends/${filename}`);
        assert.ok(readFileSync(path, 'utf8').length > 0, `${adapter} ${filename} must not be empty`);
      }
      // The public skill must link the rewritten reference paths, not bare
      // canonical backend paths that do not exist in the host surface.
      const skillText = readFileSync(join(target, ...skillDir.split('/'), 'SKILL.md'), 'utf8');
      for (const filename of ['README.md', 'files.md', 'github.md']) {
        assert.match(skillText, new RegExp(`references/backends/${filename.replace('.', '\\.')}`), `${adapter} SKILL.md`);
      }
      assert.doesNotMatch(skillText, /`agenticloop\/backends\/(files|github)\.md`/, `${adapter} SKILL.md bare backend path`);
    }
  });

  it('ships a self-validating OpenCode init path without target-local executable source', async () => {
    const target = mkdtempSync(join(tmpBase, 'target-opencode-roles-'));
    const initialized = runPacked(['init', '--target', target, '--adapter', 'opencode']);
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);

    const configPath = join(target, 'agenticloop.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    for (const [role, model] of Object.entries({
      orchestrator: 'openrouter/model-o',
      maintainer: 'openrouter/model-m',
      engineer: 'openrouter/model-e',
      auditor: 'openrouter/model-a',
    })) {
      config.adapters.opencode.roleSettings[role] ??= {};
      config.adapters.opencode.roleSettings[role].model = model;
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

    const updated = runPacked(['update', '--target', target, '--adapter', 'opencode']);
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    const validation = runPacked(['validate', '--target', target]);
    assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);

    assert.equal(existsSync(join(target, 'agenticloop', 'src')), false,
      'target toolkit payload must not contain package runtime source');
    const contractPath = join(packedRoot, 'src', 'transition-contract.js');
    const contract = await import(`${pathToFileURL(contractPath).href}?packed-test=${Date.now()}`);
    assert.deepEqual(contract.validateTransitionContractDefinition(), { ok: true, errors: [] });
    assert.strictEqual(contract.WORKFLOW_ROLE_REGISTRY, contract.TRANSITION_CONTRACT_DEFINITION.ownership.workflowRoles);
    assert.deepEqual(contract.WORKFLOW_ROLE_REGISTRY, [
      { roleId: 'orchestrator', defaultLabel: 'Orchestrator', escalationPrecedence: 10 },
      { roleId: 'maintainer', defaultLabel: 'Maintainer', escalationPrecedence: 20 },
      { roleId: 'engineer', defaultLabel: 'Engineer', escalationPrecedence: 30 },
      { roleId: 'auditor', defaultLabel: 'Auditor', escalationPrecedence: 40 },
    ]);
    assert.deepEqual(contract.WORKFLOW_ROLES, ['orchestrator', 'maintainer', 'engineer', 'auditor']);
    const filesProjection = contract.projectTransitionContract('files');
    const githubProjection = contract.projectTransitionContract('github');
    const filesSemantics = contract.projectTransitionContractSemantics('files');
    const githubSemantics = contract.projectTransitionContractSemantics('github');
    assert.deepEqual(Object.keys(filesProjection).sort(), Object.keys(githubProjection).sort());
    assert.equal(filesProjection.facts.length, contract.TRANSITION_CONTRACT_DEFINITION.facts.length);
    assert.equal(githubProjection.facts.length, contract.TRANSITION_CONTRACT_DEFINITION.facts.length);
    assert.equal(filesSemantics.ownership.workflowRoles.some(role => Object.hasOwn(role, 'defaultLabel')), false);
    assert.equal(githubSemantics.ownership.workflowRoles.some(role => Object.hasOwn(role, 'defaultLabel')), false);

    for (const [role, model] of Object.entries({
      orchestrator: 'openrouter/model-o',
      maintainer: 'openrouter/model-m',
      engineer: 'openrouter/model-e',
      auditor: 'openrouter/model-a',
    })) {
      const generated = readFileSync(join(target, '.opencode', 'agents', `${role}.md`), 'utf-8');
      assert.match(generated, new RegExp(`^model: "${model}"$`, 'm'));
      assert.match(generated, new RegExp(`Follow agenticloop/agents/${role}\\.md as the canonical role contract\\.`));
    }
    assert.ok(
      existsSync(join(target, '.opencode', 'commands', 'agenticloop.md')),
      'manual Agentic Loop activation command must be present'
    );
  });

  it('migrates a legacy custom workflow role through the documented packed-package route', () => {
    const target = mkdtempSync(join(tmpBase, 'target-role-migration-'));
    writeFileSync(join(target, 'README.md'), '# Role migration fixture\n', 'utf-8');
    const initialized = runPacked(['init', '--target', target, '--adapter', 'opencode']);
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);

    const configPath = join(target, 'agenticloop.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.roles = {
      reviewer: {
        sourceFile: 'agenticloop/agents/reviewer.md',
        requiredSkills: [],
      },
    };
    config.adapters.opencode.roleSettings.reviewer = {};
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

    const managedCustomRole = join(target, 'agenticloop', 'agents', 'reviewer.md');
    writeFileSync(managedCustomRole, '---\nname: reviewer\n---\n# Reviewer\n', 'utf-8');
    const invalid = runPacked(['validate', '--target', target]);
    assert.equal(invalid.status, 1);
    assert.match(
      `${invalid.stdout}\n${invalid.stderr}`,
      /Workflow role registry migration required:[\s\S]*npx agenticloop update[\s\S]*npx agenticloop validate/
    );

    const preservedCustomDir = join(target, 'custom-host-agents');
    mkdirSync(preservedCustomDir, { recursive: true });
    copyFileSync(managedCustomRole, join(preservedCustomDir, 'reviewer.md'));
    rmSync(managedCustomRole);
    delete config.roles;
    delete config.adapters.opencode.roleSettings.reviewer;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

    const updated = runPacked(['update', '--target', target, '--adapter', 'opencode']);
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    const valid = runPacked(['validate', '--target', target]);
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.doesNotMatch(`${valid.stdout}\n${valid.stderr}`, /^\s*(?:ERROR|WARN):/m);
    assert.equal(existsSync(join(preservedCustomDir, 'reviewer.md')), true);
  });

  it('reports usage failures with exit 2 from the packed binary', () => {
    const target = mkdtempSync(join(tmpBase, 'target-'));
    writeFileSync(join(target, 'README.md'), '# R\n', 'utf-8');
    const result = runPacked(['init', '--target', target, '--unknown-flag']);
    assert.equal(result.status, 2);
    assert.deepEqual(readdirSync(target), ['README.md'], 'invalid usage must not mutate');
  });
});

describe('packed audit, closeout, and improvement flows', () => {
  const FULL = 'a'.repeat(40);

  function git(target, args) {
    const result = spawnSync('git', args.split(' '), { cwd: target, encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(`git ${args} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  // A files-backend target in a path containing spaces, exercising Windows
  // quoting through the packed binary.
  function makeFlowTarget(name) {
    const parent = mkdtempSync(join(tmpBase, `${name} dir with spaces-`));
    const target = join(parent, 'target project');
    mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'project.md'), [
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
    ].join('\n'), 'utf-8');
    git(target, 'init -q');
    git(target, 'config user.email test@example.com');
    git(target, 'config user.name Test');
    writeFileSync(join(target, 'app.js'), 'export const v = 1;\n', 'utf-8');
    writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n', 'utf-8');
    git(target, 'add -A');
    git(target, 'commit -qm init');
    writeFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), [
      '---', 'task_id: T-001', 'status: accepted', '---', '',
      '# T-001', '', '## Grouping', '', 'milestone:M00', '', '## Comments', '', '',
    ].join('\n'), 'utf-8');
    git(target, 'add -A');
    git(target, 'commit -qm task');
    return target;
  }

  function wireReport(artifact, coveredTasks, reference) {
    return {
      report_schema: 'auditor_report_v1',
      artifact,
      covered_tasks: coveredTasks,
      invocation: { mode: 'host_subagent', reference, provenance: 'asserted' },
      perspectives: Object.fromEntries(
        ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
          .map(key => [key, `${key} body.`])
      ),
      assessment: 'Consolidated.',
      evidence_checked: 'npm test (pass)',
      verdict: 'certified',
      findings: [],
    };
  }

  it('persists Auditor reports from --file and --stdin through the packed binary', () => {
    const target = makeFlowTarget('report-flow');
    const artifact = `commit:${git(target, 'rev-parse HEAD')}`;
    const created = runPacked([
      'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o',
      '--evidence', 'npm test', '--target', target,
    ]);
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);

    const reportFile = join(target, '.agenticloop', 'tmp', 'run 1.json');
    writeFileSync(reportFile, JSON.stringify({
      ...wireReport(artifact, ['T-001'], 'packed-ref-1'),
      verdict: 'needs_remediation',
    }), 'utf-8');
    const fromFile = runPacked(['audit', 'report', 'AUD-001', '--file', reportFile, '--target', target]);
    assert.equal(fromFile.status, 0, `${fromFile.stdout}${fromFile.stderr}`);
    assert.match(fromFile.stdout, /Recorded run 1/);

    const fromStdin = spawnSync(process.execPath, [
      packedBin, 'audit', 'report', 'AUD-001', '--stdin', '--target', target,
    ], { encoding: 'utf-8', input: JSON.stringify(wireReport(artifact, ['T-001'], 'packed-ref-2')) });
    assert.equal(fromStdin.status, 0, `${fromStdin.stdout}${fromStdin.stderr}`);
    assert.match(fromStdin.stdout, /Recorded run 2/);

    const status = runPacked(['audit', 'status', 'AUD-001', '--json', '--target', target]);
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    assert.equal(JSON.parse(status.stdout).completed_audits, 2);
  });

  it('runs closeout prepare, record, and status through the packed binary', () => {
    const target = makeFlowTarget('closeout-flow');
    const artifact = `commit:${git(target, 'rev-parse HEAD')}`;
    assert.equal(runPacked([
      'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o',
      '--evidence', 'npm test', '--target', target,
    ]).status, 0);
    git(target, 'add -A');
    git(target, 'commit -qm record-audit');
    const reportFile = join(target, '.agenticloop', 'tmp', 'run.json');
    writeFileSync(reportFile, JSON.stringify(wireReport(artifact, ['T-001'], 'packed-closeout-ref')), 'utf-8');
    assert.equal(runPacked(['audit', 'report', 'AUD-001', '--file', reportFile, '--target', target]).status, 0);

    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = runPacked([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--output', packetPath, '--target', target,
    ]);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const recorded = runPacked(['closeout', 'record', '--packet', packetPath, '--yes', '--target', target]);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const status = runPacked(['closeout', 'status', '--work-unit', 'milestone:M00', '--target', target]);
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    assert.match(status.stdout, /complete \(current\)/);
  });

  it('runs improvement new, lint, and status through the packed binary', () => {
    const target = makeFlowTarget('improvement-flow');
    const artifact = `commit:${git(target, 'rev-parse HEAD')}`;
    assert.equal(runPacked([
      'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o',
      '--evidence', 'npm test', '--target', target,
    ]).status, 0);

    const bad = runPacked([
      'improvement', 'new', '--title', 'Fabricated', '--source-ref', 'not-a-real-artifact',
      '--target-surface', 'core-methodology', '--target-path', 'agenticloop/AGENTIC_LOOP.md',
      '--risk-level', 'low', '--target', target,
    ]);
    assert.equal(bad.status, 1);
    assert.ok(!existsSync(join(target, '.agenticloop', 'improvements')), 'invalid creation leaves no residue');

    const created = runPacked([
      'improvement', 'new', '--title', 'Real incident', '--source-ref', 'AUD-001',
      '--target-surface', 'core-methodology', '--target-path', 'agenticloop/AGENTIC_LOOP.md',
      '--risk-level', 'medium', '--target', target,
    ]);
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
    const lint = runPacked(['improvement', 'lint', '--target', target]);
    assert.equal(lint.status, 0, `${lint.stdout}${lint.stderr}`);
    const status = runPacked(['improvement', 'status', '--json', '--target', target]);
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).length, 1);
  });

  it('runs a GitHub-backed audit new through the packed binary with a PATH-shimmed fake gh', { timeout: 120000 }, () => {
    const target = mkdtempSync(join(tmpBase, 'gh-audit-'));
    mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: confirmed',
      'development_stage: expansion',
      'task_backend: github',
      'work_unit_audit: enabled',
      'grouping_profile: milestone',
      '---',
      '',
      '# Project',
      '',
    ].join('\n'), 'utf-8');
    const { env, logPath } = installFakeGh(tmpBase, {
      issues: [{ number: 1, state: 'CLOSED', title: '', labels: [], body: '---\ntask_id: T-001\n---\n' }],
    });
    const created = runPacked([
      'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', `commit:${FULL}`, '--goal', 'g', '--completion-oracle', 'o',
      '--evidence', 'npm test', '--target', target,
    ], { env });
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
    const invocations = readGhInvocations(logPath).map(args => args.join(' '));
    assert.ok(invocations.length > 0 && invocations.every(call => call.startsWith('issue list')),
      `GitHub audit must only read the issue inventory, got: ${invocations.join('; ')}`);
  });

  it('ships and runs the installed acting-context measurement script', () => {
    const scriptPath = join(packedRoot, 'scripts', 'measure-dispatch-context.mjs');
    assert.ok(existsSync(scriptPath), 'packed package must ship scripts/measure-dispatch-context.mjs');
    const work = mkdtempSync(join(tmpBase, 'measure-'));
    const packetPath = join(work, 'packet.json');
    writeFileSync(packetPath, JSON.stringify({ kind: 'agenticloop.role-preparation', schemaVersion: 2 }), 'utf8');
    const measured = spawnSync(process.execPath, [
      scriptPath,
      '--packet', packetPath,
      '--role-wrapper', join(packedRoot, 'agents', 'engineer.md'),
      '--activation-wrapper', join(packedRoot, 'commands', 'start.md'),
      '--reference', join(packedRoot, 'AGENTIC_LOOP.md'),
      '--reference', join(packedRoot, 'skills', 'role-delegation', 'SKILL.md'),
    ], { encoding: 'utf8' });
    assert.equal(measured.status, 0, measured.stderr);
    const result = JSON.parse(measured.stdout);
    assert.equal(result.encoding, 'utf8');
    assert.equal(result.components.length, 5);
    assert.equal(
      result.totalBytes,
      result.components.reduce((total, component) => total + component.bytes, 0)
    );
    for (const component of result.components) {
      assert.ok(component.bytes > 0, `${component.kind} must carry real bytes`);
    }
    // Duplicate components are rejected, and the canonical packet count is a
    // distinct field from the wrapper and reference bytes.
    const duplicate = spawnSync(process.execPath, [
      scriptPath,
      '--packet', packetPath,
      '--role-wrapper', join(packedRoot, 'agents', 'engineer.md'),
      '--activation-wrapper', join(packedRoot, 'agents', 'engineer.md'),
    ], { encoding: 'utf8' });
    assert.equal(duplicate.status, 2);
    assert.match(duplicate.stderr, /more than once/);
  });
});
