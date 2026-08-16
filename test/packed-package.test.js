/**
 * Packed-package boundary tests.
 *
 * One archive is packed and installed once. Source-level suites own command
 * semantics; this file proves the published artifact retains its public files,
 * exports, adapter surfaces, binary, and representative installed workflows.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { auditorReturnReportDigest } from '../src/audit-report-schema.js';
import { createAuditorReturnReceipt } from '../src/auditor-return-receipt.js';
import {
  CLI_OPERATOR_PRODUCER_ID,
  OPERATOR_CONFIRMATION_PHRASE,
  activationGrantSignaturePayload,
  createActivationGrant,
  createActivationRevocation,
  createTaskActivationBinding,
  taskActivationBindingSignaturePayload,
} from '../src/activation-grant.js';
import { loadOperatorActivationKey, signOperatorActivationPayload } from '../src/activation-trust.js';
import { activationScopeSummaryDigest, bindingRecordPath, writeActivationRecords, writeActivationRevocation } from '../src/activation-store.js';
import { targetRepositoryIdentity } from '../src/host-trust.js';
import { taskContractDigest } from '../src/task-contract-baseline.js';
import { createDispatchFixture, git, prepare } from './helpers/dispatch-fixture.js';
import { createTestHostTrust, writeHostTrustStore } from './helpers/host-trust-fixture.js';
import { runProcess } from './helpers/process-runner.js';
import { createHash } from 'node:crypto';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKED_CONCURRENCY = Math.max(1, Number.parseInt(process.env.AGENTICLOOP_PACKED_CONCURRENCY ?? '4', 10) || 4);

let tmpBase;
let packedBin;
let packedRoot;
let installPrefix;
let protectedBoundaryWrapper;
let fakeGhBin;
let fakeGhPreload;

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
    if (endpoint.includes('/issues?')) out(fx.issuePages || [fx.issues || []]);
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

function npm(args, options = {}) {
  const npmCli = process.env.npm_execpath ?? (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : null);
  return runProcess(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args, {
    timeout: 300000,
    env: { ...process.env, npm_config_cache: join(tmpBase, 'npm-cache') },
    ...options,
  });
}

before(async () => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-packed-'));
  const packDir = join(tmpBase, 'pack');
  mkdirSync(packDir, { recursive: true });

  let archivePath;
  if (process.env.AGENTICLOOP_TEST_ARCHIVE) {
    archivePath = resolve(REPO_ROOT, process.env.AGENTICLOOP_TEST_ARCHIVE);
    assert.ok(existsSync(archivePath), `requested archive is missing: ${archivePath}`);
  } else {
    const packed = await npm(['pack', '--pack-destination', packDir], { cwd: REPO_ROOT });
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stdout}\n${packed.stderr}`);
    const tarball = readdirSync(packDir).find(entry => entry.endsWith('.tgz'));
    assert.ok(tarball, 'npm pack must produce a tarball');
    archivePath = join(packDir, tarball);
  }

  installPrefix = join(tmpBase, 'prefix');
  const installed = await npm([
    'install', '--prefix', installPrefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', archivePath,
  ]);
  assert.equal(installed.status, 0, `npm install failed:\n${installed.stdout}\n${installed.stderr}`);
  packedRoot = join(installPrefix, 'node_modules', 'agenticloop');
  packedBin = join(packedRoot, 'bin', 'agenticloop.js');
  assert.ok(existsSync(packedBin), `packed binary missing at ${packedBin}`);

  protectedBoundaryWrapper = join(tmpBase, 'packed-protected-boundary-wrapper.mjs');
  writeFileSync(protectedBoundaryWrapper, [
    `import { runCli } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'cli-main.js')).href)};`,
    `import { loadProtectedAuditorReturnVerifier } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'protected-host-boundary.js')).href)};`,
    'const loaded = loadProtectedAuditorReturnVerifier({ target: process.env.AGENTICLOOP_TEST_TARGET });',
    'if (!loaded.ok) {',
    '  process.stderr.write(`boundary unavailable: ${loaded.errors.join("; ")}\\n`);',
    '  process.exit(9);',
    '}',
    'process.exitCode = await runCli(JSON.parse(process.env.AGENTICLOOP_TEST_ARGS), {',
    '  auditProvenanceVerifier: loaded.verifier,',
    '});',
    '',
  ].join('\n'), 'utf8');

  const fakeGhRoot = join(tmpBase, 'shared-fake-gh');
  fakeGhBin = join(fakeGhRoot, 'bin');
  mkdirSync(fakeGhBin, { recursive: true });
  fakeGhPreload = join(fakeGhRoot, 'fake-gh.cjs');
  writeFileSync(fakeGhPreload, FAKE_GH_RESPONDER, 'utf8');
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(fakeGhBin, 'gh.exe'));
  } else {
    const script = join(fakeGhBin, 'gh');
    writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${fakeGhPreload}" "$@"\n`, 'utf8');
    chmodSync(script, 0o755);
  }
}, { timeout: 300000 });

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function runPacked(args, options = {}) {
  return runProcess(process.execPath, [packedBin, ...args], options);
}

function installFakeGh(fixture) {
  const mutableRoot = mkdtempSync(join(tmpBase, 'fake-gh-state-'));
  const fixturePath = join(mutableRoot, 'fixture.json');
  const logPath = join(mutableRoot, 'invocations.log');
  writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');
  const preloadOption = fakeGhPreload.replace(/\\/g, '/').replaceAll('"', '\\"');
  return {
    logPath,
    env: {
      ...process.env,
      PATH: `${fakeGhBin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_GH_FIXTURE: fixturePath,
      FAKE_GH_LOG: logPath,
      ...(process.platform === 'win32' ? {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require="${preloadOption}"`.trim(),
      } : {}),
    },
  };
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

async function runThroughPackagedBoundary(args, { target, operatorTrustRoot, trust }) {
  const configDir = mkdtempSync(join(tmpBase, 'packed-protected-config-'));
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    kind: 'agenticloop.protected-host-config',
    schemaVersion: 1,
    adapterId: trust.adapterId,
    keyId: trust.keyId,
    targetRepositoryIdentity: targetRepositoryIdentity(target),
    operatorTrustRoot,
    assertedPath: null,
    privateKey: trust.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }), { mode: 0o600 });
  const descriptor = openSync(configPath, 'r');
  try {
    return await runProcess(process.execPath, [protectedBoundaryWrapper], {
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
      env: {
        ...process.env,
        AGENTICLOOP_TEST_ARGS: JSON.stringify(args),
        AGENTICLOOP_TEST_TARGET: target,
      },
    });
  } finally {
    closeSync(descriptor);
  }
}

function makeAuditTarget(name) {
  const target = mkdtempSync(join(tmpBase, `${name}-`));
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
  ].join('\n'), 'utf8');
  writeFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), [
    '---', 'task_id: T-001', 'status: accepted', '---', '', '# T-001', '',
    '## Grouping', '', 'milestone:M00', '', '## Comments', '', '',
  ].join('\n'), 'utf8');
  return target;
}

function wireReport(artifact, reference) {
  return {
    report_schema: 'auditor_report_v1',
    producer: { roleId: 'auditor' },
    artifact,
    covered_tasks: ['T-001'],
    invocation: { mode: 'host_subagent', reference, provenance: 'verified', receipt: null },
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

async function populatedStatusTarget() {
  const fixture = await createDispatchFixture(tmpBase, 'packed-status-parity-populated', { scaffold: true });
  const operatorHome = mkdtempSync(join(tmpBase, 'packed-status-home-'));
  const operatorActivationRoot = join(operatorHome, '.agenticloop', 'operator-activation');
  const env = { ...process.env, HOME: operatorHome, USERPROFILE: operatorHome };
  const provision = await runProcess(process.execPath, [
    join(REPO_ROOT, 'bin', 'agenticloop.js'), 'activation', 'provision-key', '--target', fixture.root,
  ], { env });
  assert.equal(provision.status, 0, provision.stderr);
  const operatorKey = loadOperatorActivationKey(fixture.root, { operatorActivationRoot }).key;
  const repositoryIdentity = targetRepositoryIdentity(fixture.root);
  const signGrant = overrides => {
    const issuedAt = overrides.issuedAt ?? new Date().toISOString();
    const skeleton = createActivationGrant({
      repositoryIdentity,
      backend: 'files',
      scope: { type: 'captured_request', operatorIntentDigest: `sha256:${'a'.repeat(64)}` },
      assurance: 'operator_confirmed',
      producer: { id: CLI_OPERATOR_PRODUCER_ID, channel: 'cli_interactive_confirmation' },
      evidence: {
        confirmedAt: issuedAt,
        confirmationPhrase: OPERATOR_CONFIRMATION_PHRASE,
        channel: 'cli_interactive_confirmation',
        operatorKeyId: operatorKey.keyId,
        scopeSummaryDigest: activationScopeSummaryDigest('packed lifecycle status parity'),
      },
      ...overrides,
    });
    return Object.freeze({
      ...skeleton,
      authentication: signOperatorActivationPayload(activationGrantSignaturePayload(skeleton), { key: operatorKey, repositoryIdentity }),
    });
  };
  const active = signGrant({});
  const bindingSkeleton = createTaskActivationBinding({
    grant: active,
    backend: 'files',
    taskId: 'T-001',
    carrier: '.agenticloop/tasks/T-001.md',
    taskContractDigest: taskContractDigest(readFileSync(fixture.taskPath, 'utf8')).digest,
    derivation: 'direct_operator_confirmation',
  });
  const binding = Object.freeze({
    ...bindingSkeleton,
    authentication: signOperatorActivationPayload(taskActivationBindingSignaturePayload(bindingSkeleton), { key: operatorKey, repositoryIdentity }),
  });
  assert.equal(writeActivationRecords(fixture.root, { grant: active, bindings: [binding] }).ok, true);
  const expired = signGrant({
    issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const futureIssuedAt = new Date(Date.now() + 60_000).toISOString();
  const future = signGrant({ issuedAt: futureIssuedAt, expiresAt: new Date(Date.parse(futureIssuedAt) + 60_000).toISOString() });
  const revoked = signGrant({});
  assert.equal(writeActivationRecords(fixture.root, { grant: expired, bindings: [] }).ok, true);
  assert.equal(writeActivationRecords(fixture.root, { grant: future, bindings: [] }).ok, true);
  assert.equal(writeActivationRecords(fixture.root, { grant: revoked, bindings: [] }).ok, true);
  assert.equal(writeActivationRevocation(fixture.root, createActivationRevocation({ grant: revoked })).ok, true);
  mkdirSync(join(fixture.root, '.agenticloop', 'activations', 'bindings'), { recursive: true });
  writeFileSync(join(fixture.root, bindingRecordPath('files', 'T-999')), '{ malformed', 'utf8');
  return { target: fixture.root, env, active, expired, future, revoked };
}

describe('packed package boundary', { concurrency: PACKED_CONCURRENCY }, () => {
  it('ships and imports every canonical handoff module', async () => {
    const recognition = await import(pathToFileURL(join(packedRoot, 'src', 'handoff-recognition.js')).href);
    const binding = await import(pathToFileURL(join(packedRoot, 'src', 'handoff-binding.js')).href);
    const consumption = await import(pathToFileURL(join(packedRoot, 'src', 'handoff-consumption.js')).href);
    const orientation = await import(pathToFileURL(join(packedRoot, 'src', 'lifecycle-orientation.js')).href);
    assert.equal(typeof recognition.recognizeHandoff, 'function');
    assert.equal(typeof binding.recognizeRoleStart, 'function');
    assert.equal(typeof consumption.validateDispatchConsumption, 'function');
    assert.equal(typeof orientation.lifecycleOrientationSnapshot, 'function');
  });

  it('runs installed status JSON and rejects an escaping public handoff path', async () => {
    const target = mkdtempSync(join(tmpBase, 'packed-status-'));
    const status = await runPacked(['status', '--json', '--target', target]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).kind, 'agenticloop.lifecycle-orientation');
    const rejected = await runPacked([
      'task', 'verify-return', 'T-001', '--packet', '../packet.json', '--return', '../return.json', '--json', '--target', target,
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout, /target-relative path|selected target/);
  });

  it('keeps the installed lifecycle-status projection identical to source', async () => {
    const fixture = await populatedStatusTarget();
    const args = ['status', '--json', '--target', fixture.target];
    const source = await runProcess(process.execPath, [join(REPO_ROOT, 'bin', 'agenticloop.js'), ...args], { env: fixture.env });
    const packed = await runPacked(args, { env: fixture.env });
    assert.equal(source.status, 0, source.stderr);
    assert.equal(packed.status, 0, packed.stderr);
    const projection = JSON.parse(source.stdout);
    assert.deepEqual(JSON.parse(packed.stdout), projection);
    assert.equal(projection.activationScope.scopes.some(scope => scope.grantId === fixture.active.grantId), true);
    for (const grant of [fixture.expired, fixture.future, fixture.revoked]) {
      assert.equal(projection.activationScope.scopes.some(scope => scope.grantId === grant.grantId), false);
    }
    assert.equal(projection.operatorAuthorizedSet.bindings[0].grantId, fixture.active.grantId);
    assert.ok(projection.diagnostics.some(item => item.includes('files--T-999.json is unreadable or invalid JSON')));
  });

  it('runs installed host-trust status JSON without a signing boundary', async () => {
    const target = mkdtempSync(join(tmpBase, 'packed-host-trust-status-'));
    const status = await runPacked(['host-trust', 'status', '--json', '--target', target]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).command, 'host-trust status');
  });

  it('reports the package version from the installed binary', async () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const result = await runPacked(['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`agenticloop ${pkg.version.replaceAll('.', '\\.')}`));
  });

  it('returns the CLI usage status for an invalid installed command', async () => {
    const result = await runPacked(['not-a-command']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.failure, null, 'an expected CLI failure must not be reported as a spawn failure');
  });

  it('runs the installed acting-context measurement script', async () => {
    const target = mkdtempSync(join(tmpBase, 'acting-context-'));
    const packet = join(target, 'packet.json');
    const role = join(target, 'role.md');
    const activation = join(target, 'activation.md');
    writeFileSync(packet, JSON.stringify({ task: 'T-001' }), 'utf8');
    writeFileSync(role, 'role\n', 'utf8');
    writeFileSync(activation, 'activation\n', 'utf8');
    const result = await runProcess(process.execPath, [
      join(packedRoot, 'scripts', 'measure-dispatch-context.mjs'),
      '--packet', packet,
      '--role-wrapper', role,
      '--activation-wrapper', activation,
    ], { cwd: target });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).packetSerialization, 'canonicalJson');
  });

  it('ships documented data, security modules, and maintenance helpers', async () => {
    for (const path of [
      'docs/cli-reference.md',
      'src/transition-contract.js',
      'src/activation-cli.js',
      'src/activation-grant.js',
      'src/activation-store.js',
      'src/activation-trust.js',
      'src/activation-policy.js',
      'src/activation-resolution.js',
      'src/host-trust-cli.js',
      'src/protected-host-boundary.js',
      'scripts/measure-dispatch-context.mjs',
      'scripts/sign-blocked-authority.mjs',
    ]) {
      assert.ok(existsSync(join(packedRoot, ...path.split('/'))), `${path} must be shipped`);
    }
    const boundary = await import(pathToFileURL(join(packedRoot, 'src', 'protected-host-boundary.js')).href);
    assert.equal(typeof boundary.loadProtectedAuditorReturnVerifier, 'function');
    assert.equal(boundary.PROTECTED_KEY_DESCRIPTOR, 3);
    assert.equal(boundary.readProtectedHostSigningKey, undefined);
    assert.equal(boundary.createInheritedDescriptorHostBoundary, undefined);
  });

  it('resolves documented exports, deep imports, and shipped data files', async () => {
    const probeDir = mkdtempSync(join(installPrefix, 'exports-probe-'));
    const probe = join(probeDir, 'exports-probe.mjs');
    writeFileSync(probe, [
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import { createRequire } from "node:module";',
      'const receipts = await import("agenticloop/auditor-return-receipt");',
      'const schema = await import("agenticloop/audit-report-schema");',
      'const trust = await import("agenticloop/host-trust");',
      'const grants = await import("agenticloop/activation-grant");',
       'const policy = await import("agenticloop/activation-policy");',
       'const execution = await import("agenticloop/execution-evidence");',
      'const boundary = await import("agenticloop/protected-host-boundary");',
      'const root = await import("agenticloop");',
      'assert.equal(typeof receipts.verifyAuditorReturnReceipt, "function");',
      'assert.equal(typeof receipts.AUDITOR_RECEIPT_MAX_VALIDITY_MS, "number");',
      'assert.equal(typeof schema.prepareAuditorReturnReportForSigning, "function");',
      'assert.equal(typeof trust.HOST_TRUST_CHALLENGE_TTL_MS, "number");',
      'assert.deepEqual([...grants.ACTIVATION_ASSURANCE_ORDER], ["operator_confirmed", "host_signed"]);',
       'assert.deepEqual(policy.MODE_MINIMUMS.hardened, { activation: "host_signed", return: "host_receipt" });',
       'assert.equal(typeof execution.parseRequiredCheckCommand, "function");',
      'assert.equal(typeof boundary.loadProtectedAuditorReturnVerifier, "function");',
      'assert.equal(typeof root.runCli, "function");',
      'const deep = await import("agenticloop/src/auditor-return-receipt.js");',
      'assert.equal(deep.createAuditorReturnReceipt, receipts.createAuditorReturnReceipt);',
      'await import("agenticloop/src/transition-contract.js");',
      'await import("agenticloop/src/cli-main.js");',
      'const require_ = createRequire(import.meta.url);',
      'assert.ok(JSON.parse(readFileSync(require_.resolve("agenticloop/config.json"), "utf8")).adapters);',
      'assert.ok(readFileSync(require_.resolve("agenticloop/AGENTIC_LOOP.md"), "utf8").length > 0);',
      'assert.ok(readFileSync(require_.resolve("agenticloop/agents/engineer.md"), "utf8").length > 0);',
      'console.log("ok");',
      '',
    ].join('\n'), 'utf8');
    const result = await runProcess(process.execPath, [probe], { cwd: probeDir });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ok/);
  });

  it('renders the complete public help without exposing host signing', async () => {
    const help = await runPacked(['help']);
    assert.equal(help.status, 0, help.stderr);
    for (const command of ['setup', 'init', 'doctor', 'update', 'remove', 'task', 'audit', 'worktree']) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, 'm'), `help must list '${command}'`);
    }
    for (const command of ['pr-body', 'task-readiness', 'commit-attribution', 'github-checkpoint', 'github-review-prepare']) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, 'm'), `help must list '${command}'`);
    }
    for (const forbidden of [/^\s+sign\s/m, /^\s+protected-host\s/m, /^\s+host-boundary\s/m]) {
      assert.doesNotMatch(help.stdout, forbidden);
    }
  });

  it('runs setup dry-run with a versioned plan and zero writes', async () => {
    const target = mkdtempSync(join(tmpBase, 'setup-dry-run-'));
    const result = await runPacked(['setup', '--target', target, '--adapter', 'opencode', '--dry-run', '--json']);
    assert.equal(result.status, 1, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.command, 'setup');
    assert.ok(plan.blockers.length > 0);
    assert.deepEqual(readdirSync(target), [], 'setup dry-run must not write');
  });

  it('renders the installed static contract for all five adapters', { timeout: 120000 }, async () => {
    const target = mkdtempSync(join(tmpBase, 'all-adapters-'));
    const initialized = await runPacked(['init', '--target', target, '--adapter', 'all']);
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
    const config = JSON.parse(readFileSync(join(target, 'agenticloop.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.adapters), ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']);

    const adapterFiles = {
      opencode: '.opencode/commands/agenticloop.md',
      codex: '.agents/skills/agenticloop/SKILL.md',
      'claude-code': '.claude/commands/agenticloop.md',
      copilot: '.github/prompts/agenticloop.prompt.md',
      cursor: '.cursor/skills/agenticloop/SKILL.md',
    };
    const slots = await import(pathToFileURL(join(packedRoot, 'src', 'adapter-slots.js')).href);
    for (const [adapter, relPath] of Object.entries(adapterFiles)) {
      const path = join(target, ...relPath.split('/'));
      assert.ok(existsSync(path), `${adapter} must write ${relPath}`);
      const text = readFileSync(path, 'utf8');
      assert.deepEqual(slots.validateFilledAdapterSlots(text, relPath), [], adapter);
      assert.match(text, /Activation capture capability: `unsupported`\./, adapter);
      assert.match(text, /advisory/i, adapter);
    }
    for (const [adapter, skillDir] of Object.entries({
      codex: '.agents/skills/agenticloop',
      copilot: '.github/skills/agenticloop',
      cursor: '.cursor/skills/agenticloop',
    })) {
      for (const filename of ['README.md', 'files.md', 'github.md']) {
        const path = join(target, ...skillDir.split('/'), 'references', 'backends', filename);
        assert.ok(existsSync(path), `${adapter} must ship ${filename}`);
        assert.ok(readFileSync(path, 'utf8').length > 0, `${adapter} ${filename} must not be empty`);
      }
    }
  });

  it('runs one installed OpenCode init-update-validate workflow', { timeout: 120000 }, async () => {
    const target = mkdtempSync(join(tmpBase, 'opencode-workflow-'));
    const initialized = await runPacked(['init', '--target', target, '--adapter', 'opencode']);
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
    const configPath = join(target, 'agenticloop.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    for (const [role, model] of Object.entries({
      orchestrator: 'openrouter/model-o',
      maintainer: 'openrouter/model-m',
      engineer: 'openrouter/model-e',
      auditor: 'openrouter/model-a',
    })) {
      config.adapters.opencode.roleSettings[role] ??= {};
      config.adapters.opencode.roleSettings[role].model = model;
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const updated = await runPacked(['update', '--target', target, '--adapter', 'opencode']);
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    const validated = await runPacked(['validate', '--target', target]);
    assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
    assert.equal(existsSync(join(target, 'agenticloop', 'src')), false);
    for (const [role, model] of Object.entries({
      orchestrator: 'openrouter/model-o',
      maintainer: 'openrouter/model-m',
      engineer: 'openrouter/model-e',
      auditor: 'openrouter/model-a',
    })) {
      const generated = readFileSync(join(target, '.opencode', 'agents', `${role}.md`), 'utf8');
      assert.match(generated, new RegExp(`^model: "${model}"$`, 'm'));
    }
  });

  it('runs one installed scaffold-edit-lint workflow through read-only fake gh', { timeout: 120000 }, async () => {
    const head = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const fixture = {
      prData: {
        number: 7,
        body: 'stale remote draft that was never updated',
        baseRefOid: 'b'.repeat(40),
        headRefOid: head,
        files: [],
        closingIssuesReferences: [{ number: 3 }],
        statusCheckRollup: [],
        commits: [{ oid: head, message: 'implement T-007\n\nTask: T-007\nAgent: engineer' }],
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
    const { env, logPath } = installFakeGh(fixture);
    const scaffold = await runPacked([
      'pr-body', 'scaffold', '--pr', '7', '--output', 'body.md',
      '--snapshot-output', 'ctx.snapshot.json', '--json',
    ], { cwd: target, env });
    assert.equal(scaffold.status, 0, scaffold.stderr + scaffold.stdout);
    const scaffoldResult = JSON.parse(scaffold.stdout);
    assert.equal(scaffoldResult.nextCommand, 'npx agenticloop pr-body lint --pr 7 --body-file body.md');
    const bodyPath = join(target, 'body.md');
    assert.ok(existsSync(bodyPath));
    assert.ok(existsSync(join(target, 'ctx.snapshot.json')));

    const plainEnv = { ...process.env };
    delete plainEnv.NODE_OPTIONS;
    const placeholder = await runPacked([
      'pr-body', 'lint', '--snapshot', 'ctx.snapshot.json', '--body-file', 'body.md', '--json',
    ], { cwd: target, env: plainEnv });
    assert.equal(placeholder.status, 1, placeholder.stderr);
    assert.match(JSON.parse(placeholder.stdout).errors.join('\n'), /placeholder/i);

    writeFileSync(bodyPath, [
      '## Scope Completed', 'Completed the scoped change.', '',
      '## Artifacts', `Current implementation artifact: commit:${head}`, '',
      '## Evidence', `Current PR head: ${head}`, '',
      '- Required check: [RC-1] `npm test`', '  Verdict: passed',
      '  Evidence: 47 tests passed (exit 0)', '',
      '## Deviations', 'None.', '', '## Known Gaps', 'None.', '',
      '## Follow-Ups', 'None.', '', '[[agent: engineer]]',
    ].join('\n'), 'utf8');
    const offline = await runPacked([
      'pr-body', 'lint', '--snapshot', 'ctx.snapshot.json', '--body-file', 'body.md', '--json',
    ], { cwd: target, env: plainEnv });
    assert.equal(offline.status, 0, offline.stderr + offline.stdout);
    assert.equal(JSON.parse(offline.stdout).contextMode, 'snapshot');

    const live = await runPacked(['pr-body', 'lint', '--pr', '7', '--body-file', 'body.md', '--json'], {
      cwd: target,
      env,
    });
    assert.equal(live.status, 0, live.stderr + live.stdout);
    assert.equal(JSON.parse(live.stdout).contextMode, 'live');
    const invocations = readGhInvocations(logPath);
    assert.ok(invocations.length > 0, 'live modes must read GitHub context through gh');
    assertReadOnlyGhInvocations(invocations);
  });

  it('persists one signed Auditor return through the installed protected-host path', { timeout: 120000 }, async () => {
    const target = makeAuditTarget('protected-audit');
    const artifact = `commit:${'a'.repeat(40)}`;
    const created = await runPacked([
      'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o',
      '--evidence', 'npm test', '--target', target,
    ]);
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
    const operatorTrustRoot = mkdtempSync(join(tmpBase, 'protected-audit-operator-'));
    const trust = createTestHostTrust({ target });
    writeHostTrustStore(operatorTrustRoot, trust);
    const report = wireReport(artifact, 'packed-protected-ref');
    const receiptNow = Date.now();
    const receipt = createAuditorReturnReceipt({
      receiptId: 'packed-protected-receipt',
      adapterId: trust.adapterId,
      keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: report.invocation.reference,
      invocationMode: report.invocation.mode,
      workUnit: 'milestone:M00',
      candidateArtifact: artifact,
      coveredTasks: report.covered_tasks,
      reportDigest: auditorReturnReportDigest(report),
      issuedAt: new Date(receiptNow - 60_000).toISOString(),
      expiresAt: new Date(receiptNow + 300_000).toISOString(),
    }, trust.privateKey);
    report.invocation.receipt = JSON.stringify(receipt);
    const reportFile = join(target, '.agenticloop', 'tmp', 'protected-report.json');
    writeFileSync(reportFile, JSON.stringify(report), 'utf8');
    const persisted = await runThroughPackagedBoundary([
      'audit', 'report', 'AUD-001', '--file', reportFile, '--target', target,
    ], { target, operatorTrustRoot, trust });
    assert.equal(persisted.status, 0, `${persisted.stdout}${persisted.stderr}`);
    assert.doesNotMatch(persisted.stdout + persisted.stderr, /BEGIN (?:EC |RSA )?PRIVATE KEY/);
    const status = await runPacked(['audit', 'status', 'AUD-001', '--json', '--target', target]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).completed_audits, 1);
  });
});

describe('packed public handoff lifecycle', () => {
  /** Run an installed command with only the external operator trust root. */
  async function runPackedWithHostContext(args, operatorTrustRoot) {
    const wrapper = join(tmpBase, 'packed-host-context-wrapper.mjs');
    if (!existsSync(wrapper)) {
      writeFileSync(wrapper, [
        `import { runCli } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'cli-main.js')).href)};`,
        'process.exitCode = await runCli(JSON.parse(process.env.AGENTICLOOP_TEST_ARGS), {',
        '  operatorTrustRoot: process.env.AGENTICLOOP_TEST_OPERATOR_ROOT,',
        '});',
        '',
      ].join('\n'), 'utf8');
    }
    return runProcess(process.execPath, [wrapper], {
      env: {
        ...process.env,
        AGENTICLOOP_TEST_ARGS: JSON.stringify(args),
        AGENTICLOOP_TEST_OPERATOR_ROOT: operatorTrustRoot,
      },
    });
  }

  /**
   * Run an installed command behind a real protected host boundary.
   *
   * The boundary's private key is handed to the child on file descriptor 3 and
   * never appears in the environment, the argv, or the target repository - the
   * same discipline a real host wrapper must follow.
   */
  async function runPackedWithChallengeBoundary(args, { operatorTrustRoot, adapterId, keyId, privateKey }) {
    const wrapper = join(tmpBase, 'packed-challenge-boundary-wrapper.mjs');
    if (!existsSync(wrapper)) {
      writeFileSync(wrapper, [
        `import { runCli } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'cli-main.js')).href)};`,
        `import { HOST_TRUST_BOUNDARY_RESPONSE_KIND, HOST_TRUST_BOUNDARY_SCHEMA_VERSION, hostTrustBoundarySignaturePayload, signHostPayload } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'host-trust.js')).href)};`,
        'import { createPrivateKey } from "node:crypto";',
        'import { readFileSync } from "node:fs";',
        'const boundaryKey = createPrivateKey({ key: readFileSync(3), format: "der", type: "pkcs8" });',
        'process.exitCode = await runCli(JSON.parse(process.env.AGENTICLOOP_TEST_ARGS), {',
        '  operatorTrustRoot: process.env.AGENTICLOOP_TEST_OPERATOR_ROOT,',
        '  hostAuthority: challenge => {',
        '    const response = {',
        '      kind: HOST_TRUST_BOUNDARY_RESPONSE_KIND,',
        '      schemaVersion: HOST_TRUST_BOUNDARY_SCHEMA_VERSION,',
        '      adapterId: process.env.AGENTICLOOP_TEST_ADAPTER,',
        '      keyId: process.env.AGENTICLOOP_TEST_KEY_ID,',
        '      challengeNonce: challenge.nonce,',
        '      signature: null,',
        '    };',
        '    response.signature = signHostPayload(hostTrustBoundarySignaturePayload(challenge, response), boundaryKey);',
        '    return response;',
        '  },',
        '});',
        '',
      ].join('\n'), 'utf8');
    }
    const keyPath = join(tmpBase, `packed-challenge-boundary-${Math.random().toString(36).slice(2)}.pk8`);
    writeFileSync(keyPath, privateKey.export({ format: 'der', type: 'pkcs8' }), { mode: 0o600 });
    const keyDescriptor = openSync(keyPath, 'r');
    try {
      return await runProcess(process.execPath, [wrapper], {
        stdio: ['ignore', 'pipe', 'pipe', keyDescriptor],
        env: {
          ...process.env,
          AGENTICLOOP_TEST_ARGS: JSON.stringify(args),
          AGENTICLOOP_TEST_OPERATOR_ROOT: operatorTrustRoot,
          AGENTICLOOP_TEST_ADAPTER: adapterId,
          AGENTICLOOP_TEST_KEY_ID: keyId,
        },
      });
    } finally {
      closeSync(keyDescriptor);
      rmSync(keyPath, { force: true });
    }
  }

  it('keeps installed public dispatch fail-closed for a caller-supplied supported registry', async () => {
    const fixture = await createDispatchFixture(tmpBase, 'packed-dispatch-fail-closed');
    writeFileSync(
      join(fixture.root, 'dispatch-input.json'),
      JSON.stringify({
        readiness: fixture.readiness,
        decomposition: fixture.decomposition,
        assignment: fixture.assignment,
      }),
      'utf8'
    );
    const prepared = await runPackedWithHostContext([
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

  it('emits a committable decomposition source from the installed read-only producer', async () => {
    const fixture = await createDispatchFixture(tmpBase, 'packed-decomposition');
    const baseTree = fixture.readiness.evidence.base.identity.slice('git-tree:'.length);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    const before = git(fixture.root, ['status', '--porcelain']);

    const produced = await runPacked([
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'packed-work-unit',
      '--source-ref', '.agenticloop/decompositions/T-001-packed.json',
      '--source-revision', `git-commit:${head}`,
      '--base', baseTree,
      '--dependencies', 'dependencies.json',
      '--json',
      '--target', fixture.root,
    ]);
    assert.equal(produced.status, 0, `${produced.stdout}${produced.stderr}`);
    const decomposition = JSON.parse(produced.stdout);
    assert.equal(decomposition.kind, 'agenticloop.decomposition-provenance');
    assert.equal(decomposition.schemaVersion, 2);
    assert.equal(decomposition.scan.schemaVersion, 2);
    assert.equal(decomposition.scan.inventory.complete, true);
    assert.equal(decomposition.scan.inventory.enumeration.enumerator, 'agenticloop.files-task-directory.v1');
    assert.equal(decomposition.scan.inventory.enumeration.completion, 'exhaustive');
    assert.ok(decomposition.scan.readinessContext.digest);
    // The semantic dependency identity and the persisted target-relative
    // revalidation selector are distinct durable facts.
    assert.equal(decomposition.scan.readinessContext.dependencies.source, 'files:.agenticloop/tasks');
    assert.equal(decomposition.scan.readinessContext.dependencies.sourceRef, 'dependencies.json');

    // The installed producer is read-only: it writes nothing, stages nothing,
    // and leaves the target worktree exactly as it found it.
    const after = git(fixture.root, ['status', '--porcelain']);
    assert.equal(after, before);

    // The emitted source is committable and the installed validator accepts it.
    const sourcePath = join(fixture.root, '.agenticloop', 'decompositions', 'T-001-packed.json');
    writeFileSync(sourcePath, produced.stdout, 'utf8');
    git(fixture.root, ['add', '.agenticloop/decompositions/T-001-packed.json']);
    git(fixture.root, ['commit', '-m', 'record packed decomposition\n\nTask: T-001\nAgent: maintainer']);
    const scan = await import(pathToFileURL(join(packedRoot, 'src', 'parallel-scan.js')).href);
    const committed = JSON.parse(readFileSync(sourcePath, 'utf8'));
    assert.equal(scan.validateParallelScanRecord(committed.scan).ok, true);
  });

  it('runs installed handoff-preflight with --repair-plan and produces a valid refresh plan', async () => {
    const fixture = await createDispatchFixture(tmpBase, 'packed-preflight-repair-plan');
    const preflight = await runPacked([
      'task', 'handoff-preflight', 'T-001',
      '--repair-plan', '.agenticloop/tmp/refresh-plan.json',
      '--json', '--target', fixture.root,
    ]);
    // Preflight may succeed or block; either way it should produce valid JSON
    const result = JSON.parse(preflight.stdout);
    assert.equal(result.kind, 'agenticloop.handoff-preflight');
    assert.equal(result.taskId, 'T-001');
    assert.ok(result.refreshPlan, 'installed preflight with --repair-plan should include refreshPlan');
    assert.equal(result.refreshPlan.kind, 'agenticloop.handoff-evidence-refresh-plan');
    assert.ok(result.refreshPlanPath, 'installed preflight should include refreshPlanPath');
    // The plan file should be written to the target
    const planPath = join(fixture.root, '.agenticloop', 'tmp', 'refresh-plan.json');
    assert.ok(existsSync(planPath), 'plan file should exist in target');
    const planContent = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(planContent.kind, 'agenticloop.handoff-evidence-refresh-plan');
    assert.ok(Array.isArray(planContent.categories));
  });

  it('runs installed refresh-handoff-evidence with a valid plan and applies it', async () => {
    const fixture = await createDispatchFixture(tmpBase, 'packed-refresh-evidence');
    // Step 1: Generate a plan via handoff-preflight
    const preflight = await runPacked([
      'task', 'handoff-preflight', 'T-001',
      '--repair-plan', '.agenticloop/tmp/refresh-plan.json',
      '--json', '--target', fixture.root,
    ]);
    const preflightResult = JSON.parse(preflight.stdout);
    assert.ok(preflightResult.refreshPlan, 'preflight should produce a plan');

    // Step 2: Apply the plan via refresh-handoff-evidence
    const refresh = await runPacked([
      'task', 'refresh-handoff-evidence', 'T-001',
      '--plan', '.agenticloop/tmp/refresh-plan.json',
      '--yes', '--json', '--target', fixture.root,
    ]);
    assert.equal(refresh.status, 0, `refresh should succeed\nstderr:\n${refresh.stderr}`);
    const refreshResult = JSON.parse(refresh.stdout);
    assert.ok(refreshResult.receipt, 'refresh result should have a receipt');
    assert.ok(Array.isArray(refreshResult.changedFiles), 'result should have changedFiles array');
    // At least the receipt file should be changed
    assert.ok(refreshResult.changedFiles.length > 0, 'should have at least one changed file');
    assert.ok(refreshResult.changedFiles.some(f => f.includes('T-001')), 'changed files should reference the task');
  });

  it('installed refresh-handoff-evidence rejects invocation without --yes', async () => {
    const fixture = await createDispatchFixture(tmpBase, 'packed-refresh-no-yes');
    // Generate a plan first
    await runPacked([
      'task', 'handoff-preflight', 'T-001',
      '--repair-plan', '.agenticloop/tmp/refresh-plan.json',
      '--json', '--target', fixture.root,
    ]);

    // Try to refresh without --yes
    const refresh = await runPacked([
      'task', 'refresh-handoff-evidence', 'T-001',
      '--plan', '.agenticloop/tmp/refresh-plan.json',
      '--json', '--target', fixture.root,
    ]);
    assert.equal(refresh.status, 2, 'missing --yes should exit with usage error');
    const result = JSON.parse(refresh.stdout);
    assert.ok(result.evidenceState, 'result should have evidenceState');
    assert.match(result.diagnostics[0].message, /--yes/);
  });

  it('returns one installed authoritative handoff verdict for all five adapters', { timeout: 300000 }, async () => {
    const verdicts = {};
    const successfulVerdicts = {};
    for (const adapter of ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']) {
      const fixture = await createDispatchFixture(tmpBase, `installed-handoff-${adapter}`);
      const initialized = await runPacked(['init', '--target', fixture.root, '--adapter', adapter]);
      assert.equal(initialized.status, 0, `${adapter}: ${initialized.stdout}\n${initialized.stderr}`);
      git(fixture.root, ['add', '-A']);
      git(fixture.root, ['commit', '-m', `install ${adapter} adapter\n\nTask: T-001\nAgent: maintainer`]);
      const installedHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const currentRepository = () => ({ ...fixture.repository(), head: installedHead, baseHead: installedHead });
      const prepared = prepare(fixture, {
        repository: currentRepository,
        refetchRepository: currentRepository,
      });
      assert.equal(prepared.ok, true, `${adapter}: ${prepared.validation.errors?.join('; ')}`);
      mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
      writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'dispatch.json'), JSON.stringify(prepared.packet), 'utf8');

      const guidance = readFileSync(join(fixture.root, 'agenticloop', 'skills', 'role-delegation', 'SKILL.md'), 'utf8');
      assert.match(guidance, /prepare-dispatch <id> --host <host> --role engineer/, adapter);
      assert.match(guidance, /task status <id> in-progress --dispatch-packet/, adapter);
      assert.match(guidance, /task verify-return/, adapter);

      const taskPath = join(fixture.root, '.agenticloop', 'tasks', 'T-001.md');
      const before = readFileSync(taskPath, 'utf8');
      const digest = `sha256:${createHash('sha256').update(before, 'utf8').digest('hex')}`;
      const refused = await runPacked([
        'task', 'status', 'T-001', 'in-progress', '--expect-digest', digest,
        '--json', '--target', fixture.root,
      ]);
      assert.equal(refused.status, 1, `${adapter}: ${refused.stdout}\n${refused.stderr}`);
      assert.equal(readFileSync(taskPath, 'utf8'), before, `${adapter} refusal must not mutate the carrier`);
      const handoff = JSON.parse(refused.stdout).handoff_recognition;
      verdicts[adapter] = {
        transition: handoff.transition,
        requirement: handoff.requirement,
        recognized: handoff.recognized,
        evidenceState: handoff.evidenceState,
        disposition: handoff.disposition,
        diagnosticCodes: handoff.diagnostics.map(item => item.code),
      };

      const accepted = await runPackedWithChallengeBoundary([
        'task', 'status', 'T-001', 'in-progress', '--expect-digest', digest,
        '--dispatch-packet', '.agenticloop/tmp/dispatch.json', '--json', '--target', fixture.root,
      ], {
        operatorTrustRoot: fixture.operatorTrustRoot,
        adapterId: fixture.trust.adapterId,
        keyId: fixture.trust.keyId,
        privateKey: fixture.trust.privateKey,
      });
      assert.equal(accepted.status, 0, `${adapter}: ${accepted.stdout}\n${accepted.stderr}`);
      const recognized = JSON.parse(accepted.stdout).handoff_recognition;
      successfulVerdicts[adapter] = {
        transition: recognized.transition,
        requirement: recognized.requirement,
        recognized: recognized.recognized,
        evidenceState: recognized.evidenceState,
        disposition: recognized.disposition,
        diagnosticCodes: recognized.diagnostics.map(item => item.code),
      };
    }
    const [reference, ...rest] = Object.values(verdicts);
    for (const verdict of rest) assert.deepEqual(verdict, reference, JSON.stringify(verdicts, null, 2));
    assert.deepEqual(reference, {
      transition: 'role_start', requirement: 'prepared_dispatch', recognized: false,
      evidenceState: 'missing', disposition: 'needs_context',
      diagnosticCodes: ['handoff.evidence.missing', 'handoff.evidence.unauthenticated'],
    });
    const [successfulReference, ...successfulRest] = Object.values(successfulVerdicts);
    for (const verdict of successfulRest) {
      assert.deepEqual(verdict, successfulReference, JSON.stringify(successfulVerdicts, null, 2));
    }
    assert.deepEqual(successfulReference, {
      transition: 'role_start', requirement: 'prepared_dispatch', recognized: true,
      evidenceState: 'current', disposition: 'proceed', diagnosticCodes: [],
    });
  });

  it('runs the installed files lifecycle across every public handoff boundary', { timeout: 300000 }, async () => {
    // Every lifecycle transition uses the packaged public CLI. No packet,
    // check, return, or repository-evidence JSON is hand-authored.
    const fixture = await createDispatchFixture(tmpBase, 'packed-files-lifecycle', {
      requiredChecksText: '- [RC-1] command: `node --version`\n- [RC-2] command: `node --version`',
    });
    const viaBoundary = args => runPackedWithChallengeBoundary(args, {
      operatorTrustRoot: fixture.operatorTrustRoot,
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      privateKey: fixture.trust.privateKey,
    });
    // Packet-consuming public commands must receive the external trust root
    // that recognizes the fixture's operator-pinned adapter. They do not get
    // a caller-authored capability inventory or bypass packet validation.
    const withPacketTrust = args => runPackedWithHostContext(args, fixture.operatorTrustRoot);
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });

    // The exact documented ordinary dispatch: no dispatch-input.json anywhere.
    const prepared = await viaBoundary([
      'task', 'prepare-dispatch', 'T-001',
      '--host', 'opencode', '--role', 'engineer',
      '--output', '.agenticloop/tmp/T-001.packet.json',
      '--json', '--target', fixture.root,
    ]);
    assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
    const packet = JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'tmp', 'T-001.packet.json'), 'utf8'));
    assert.equal(packet.task.id, 'T-001');
    assert.equal(packet.assignment.host, 'opencode');

    const taskPath = join(fixture.root, '.agenticloop', 'tasks', 'T-001.md');
    const carrierDigest = () =>
      `sha256:${createHash('sha256').update(readFileSync(taskPath, 'utf8'), 'utf8').digest('hex')}`;
    const started = await viaBoundary([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', carrierDigest(),
      '--dispatch-packet', '.agenticloop/tmp/T-001.packet.json', '--json', '--target', fixture.root,
    ]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    git(fixture.root, ['add', '.agenticloop/tasks', '.agenticloop/handoffs']);
    git(fixture.root, ['commit', '-m', 'Start Engineer work\n\nTask: T-001\nAgent: engineer']);

    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "packed";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'Implement packed lifecycle work\n\nTask: T-001\nAgent: engineer']);
    const productHead = git(fixture.root, ['rev-parse', 'HEAD']);

    const artifact = await runPacked([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', carrierDigest(), '--product-head', productHead,
      '--json', '--target', fixture.root,
    ]);
    assert.equal(artifact.status, 0, `${artifact.stdout}\n${artifact.stderr}`);
    git(fixture.root, ['add', '.agenticloop/tasks', '.agenticloop/handoffs']);
    git(fixture.root, ['commit', '-m', 'Record implementation artifact\n\nTask: T-001\nAgent: engineer']);

    const checksInit = await withPacketTrust([
      'task', 'check-evidence-init', 'T-001',
      '--packet', '.agenticloop/tmp/T-001.packet.json',
      '--output', '.agenticloop/tmp/T-001.checks.json', '--json', '--target', fixture.root,
    ]);
    assert.equal(checksInit.status, 0, `${checksInit.stdout}\n${checksInit.stderr}`);
    for (const check of ['RC-1', 'RC-2']) {
      const updated = await withPacketTrust([
        'task', 'check-evidence-update', 'T-001',
        '--packet', '.agenticloop/tmp/T-001.packet.json',
        '--input', '.agenticloop/tmp/T-001.checks.json',
        '--output', '.agenticloop/tmp/T-001.checks.json',
        '--check', check, '--outcome', 'passed', '--evidence', `${check} passed`,
        '--execution-output', `.agenticloop/tmp/${check}.execution.json`,
        '--json', '--target', fixture.root,
      ]);
      assert.equal(updated.status, 0, `${check}: ${updated.stdout}\n${updated.stderr}`);
      const execution = JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'tmp', `${check}.execution.json`), 'utf8'));
      assert.equal(execution.execution.outcome, 'passed');
      assert.equal(execution.execution.childExitCode, 0);
    }

    const returned = await viaBoundary([
      'task', 'prepare-return', 'T-001',
      '--packet', '.agenticloop/tmp/T-001.packet.json',
      '--check-evidence', '.agenticloop/tmp/T-001.checks.json',
      '--outcome', 'implementation_ready_for_review',
      '--output', '.agenticloop/tmp/T-001.return.json',
      '--json', '--target', fixture.root,
    ]);
    assert.equal(returned.status, 0, `${returned.stdout}\n${returned.stderr}`);
    const roleReturn = JSON.parse(readFileSync(join(fixture.root, '.agenticloop', 'tmp', 'T-001.return.json'), 'utf8'));
    assert.equal(roleReturn.productHead, productHead);
    assert.equal(roleReturn.outcome.kind, 'implementation_ready_for_review');

    // Verification independently rederives repository evidence from current
    // Git/task facts: no repository-evidence JSON is supplied.
    const verified = await viaBoundary([
      'task', 'verify-return', 'T-001',
      '--packet', '.agenticloop/tmp/T-001.packet.json',
      '--return', '.agenticloop/tmp/T-001.return.json',
      '--from-current-repository',
      '--json', '--target', fixture.root,
    ]);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    assert.equal(JSON.parse(verified.stdout).ok, true);
    const verificationFiles = readdirSync(join(fixture.root, '.agenticloop', 'returns', 'verifications'));
    assert.equal(verificationFiles.length, 1);
    const persistedVerification = JSON.parse(readFileSync(
      join(fixture.root, '.agenticloop', 'returns', 'verifications', verificationFiles[0]), 'utf8'
    ));
    assert.equal(persistedVerification.requiredCheckEvidenceAssurance, 'unverified');
    assert.equal(persistedVerification.evidence.producerIdentityAuthenticated, false);

    const review = await viaBoundary([
      'task', 'review-prepare', 'T-001', '--json', '--target', fixture.root,
    ]);
    assert.equal(review.status, 0, `${review.stdout}\n${review.stderr}`);
    const reviewEntry = JSON.parse(review.stdout);
    assert.equal(reviewEntry.handoff_recognition.boundIdentity.packetId, packet.packetId);
    assert.equal(reviewEntry.currentCarrierDigest, carrierDigest());
    const persistedReview = JSON.parse(readFileSync(join(fixture.root, reviewEntry.reviewEntryPath), 'utf8'));
    assert.equal(persistedReview.handoffRecognitionDigest, reviewEntry.handoff_recognition.digest);
    assert.equal(persistedReview.dispatchCarrierDigest, packet.task.dispatchCarrierDigest);
    assert.equal(reviewEntry.findingResolutionMatrix, null, 'no finding-resolution matrix should be created when the task record has no Maintainer Review Fixup');
    assert.equal(reviewEntry.matrixDecision, null);
  });

  it('upgrades a genuine 0.4.0 installation and exercises the public lifecycle', { timeout: 600000 }, async () => {
    // Materialize the 0.4.0 release source from Git without touching the
    // current worktree, then pack and install it exactly like a downstream
    // project would have before this release line.
    const priorCommit = 'be5790d9c33f40d496d9ad2a75a101a4adb634f6';
    const priorSrc = join(tmpBase, 'prior-src');
    const priorTar = join(tmpBase, 'prior-src.tar');
    mkdirSync(priorSrc, { recursive: true });
    const archived = await runProcess('git', ['archive', priorCommit, '-o', priorTar], { cwd: REPO_ROOT });
    assert.equal(archived.status, 0, archived.stderr);
    const extracted = await runProcess('tar', ['-xf', 'prior-src.tar', '-C', 'prior-src'], { cwd: tmpBase });
    assert.equal(extracted.status, 0, extracted.stderr);
    const priorPackDir = join(tmpBase, 'prior-pack');
    mkdirSync(priorPackDir, { recursive: true });
    const priorPacked = await npm(['pack', '--pack-destination', priorPackDir], { cwd: priorSrc });
    assert.equal(priorPacked.status, 0, `${priorPacked.stdout}\n${priorPacked.stderr}`);
    const priorTarball = join(priorPackDir, readdirSync(priorPackDir).find(entry => entry.endsWith('.tgz')));
    const priorPrefix = join(tmpBase, 'prior-prefix');
    const priorInstalled = await npm([
      'install', '--prefix', priorPrefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', priorTarball,
    ]);
    assert.equal(priorInstalled.status, 0, `${priorInstalled.stdout}\n${priorInstalled.stderr}`);
    const priorBin = join(priorPrefix, 'node_modules', 'agenticloop', 'bin', 'agenticloop.js');
    const priorVersion = await runProcess(process.execPath, [priorBin, '--version']);
    assert.match(priorVersion.stdout, /agenticloop 0\.4\.0/);

    // A genuine 0.4.0 installation: init, configure the canonical role models,
    // update, and validate with the 0.4.0 binary.
    const target = mkdtempSync(join(tmpBase, 'upgrade-target-'));
    const initialized = await runProcess(process.execPath, [priorBin, 'init', '--target', target, '--adapter', 'opencode']);
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
    const configPath = join(target, 'agenticloop.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    for (const role of ['orchestrator', 'maintainer', 'engineer', 'auditor']) {
      config.adapters.opencode.roleSettings[role] ??= {};
      config.adapters.opencode.roleSettings[role].model = `openrouter/model-${role[0]}`;
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const priorUpdated = await runProcess(process.execPath, [priorBin, 'update', '--target', target, '--adapter', 'opencode']);
    assert.equal(priorUpdated.status, 0, `${priorUpdated.stdout}\n${priorUpdated.stderr}`);
    const priorValidated = await runProcess(process.execPath, [priorBin, 'validate', '--target', target]);
    assert.equal(priorValidated.status, 0, `${priorValidated.stdout}\n${priorValidated.stderr}`);

    // Upgrade in place to the current package, then prove the public
    // lifecycle: update, validation with zero errors, and the canonical
    // read-only orientation snapshot.
    const currentArchive = readdirSync(join(tmpBase, 'pack')).find(entry => entry.endsWith('.tgz'));
    const upgraded = await npm([
      'install', '--prefix', priorPrefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline',
      join(tmpBase, 'pack', currentArchive),
    ]);
    assert.equal(upgraded.status, 0, `${upgraded.stdout}\n${upgraded.stderr}`);
    const currentBin = join(priorPrefix, 'node_modules', 'agenticloop', 'bin', 'agenticloop.js');
    const updated = await runProcess(process.execPath, [currentBin, 'update', '--target', target, '--adapter', 'opencode']);
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    const validated = await runProcess(process.execPath, [currentBin, 'validate', '--target', target]);
    assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
    assert.doesNotMatch(`${validated.stdout}\n${validated.stderr}`, /^\s*ERROR:/m);
    const status = await runProcess(process.execPath, [currentBin, 'status', '--json', '--target', target]);
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.equal(JSON.parse(status.stdout).kind, 'agenticloop.lifecycle-orientation');
    // The installed 0.4.0 assets were refreshed, not preserved as canonical source.
    assert.equal(existsSync(join(target, 'agenticloop', 'src')), false);
  });

  it('rejects escaping installed public artifact selectors', async () => {    const fixture = await createDispatchFixture(tmpBase, 'packed-path-confinement');
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    for (const selector of ['/absolute/packet.json', '../packet.json', 'C:/packet.json']) {
      const rejected = await runPacked([
        'task', 'prepare-dispatch', 'T-001', '--packet', selector, '--role', 'engineer',
        '--json', '--target', fixture.root,
      ]);
      assert.notEqual(rejected.status, 0, selector);
      assert.match(rejected.stdout, /target-relative|selected target|repository-relative/, selector);
    }
    const outside = join(fixture.root, '..', 'outside-packet.json');
    writeFileSync(outside, '{}', 'utf8');
    const traversal = await runPacked([
      'task', 'verify-return', 'T-001', '--packet', '../outside-packet.json',
      '--return', '../outside-packet.json', '--json', '--target', fixture.root,
    ]);
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stdout, /target-relative|selected target/);
  });
});
