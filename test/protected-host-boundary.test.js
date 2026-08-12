import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { auditorReturnReportDigest } from '../src/audit-report-schema.js';
import { createAuditorReturnReceipt } from '../src/auditor-return-receipt.js';
import { generateHostSigningKey, targetRepositoryIdentity } from '../src/host-trust.js';
import { createTestHostTrust, writeHostTrustStore } from './helpers/host-trust-fixture.js';
import { runProcess } from './helpers/process-runner.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpBase;
let boundaryWrapper;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-protected-host-'));
  boundaryWrapper = join(tmpBase, 'protected-boundary-wrapper.mjs');
  writeFileSync(boundaryWrapper, [
    `import { runCli } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src', 'cli-main.js')).href)};`,
    `import { loadProtectedAuditorReturnVerifier } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src', 'protected-host-boundary.js')).href)};`,
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
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function runSource(args, options = {}) {
  return runProcess(process.execPath, [BIN, ...args], options);
}

function makeTarget(name) {
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

async function setup(name) {
  const target = makeTarget(name);
  const artifact = `commit:${'a'.repeat(40)}`;
  assert.equal((await runSource([
    'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
    '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o',
    '--evidence', 'npm test', '--target', target,
  ])).status, 0);
  const operatorTrustRoot = mkdtempSync(join(tmpBase, `${name}-operator-`));
  const trust = createTestHostTrust({ target });
  writeHostTrustStore(operatorTrustRoot, trust);
  const report = wireReport(artifact, `${name}-ref`);
  const receiptNow = Date.now();
  const receipt = createAuditorReturnReceipt({
    receiptId: `${name}-receipt`,
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
  const reportFile = join(target, '.agenticloop', 'tmp', `${name}.json`);
  writeFileSync(reportFile, JSON.stringify(report), 'utf8');
  return {
    target,
    operatorTrustRoot,
    trust,
    run: overrides => runThroughBoundary([
      'audit', 'report', 'AUD-001', '--file', reportFile, '--target', target,
    ], {
      target,
      operatorTrustRoot,
      adapterId: trust.adapterId,
      keyId: trust.keyId,
      privateKey: trust.privateKey,
      ...overrides,
    }),
  };
}

async function runThroughBoundary(args, {
  target,
  operatorTrustRoot,
  adapterId,
  keyId,
  privateKey,
  withKey = true,
  configBytes = null,
  configOverrides = {},
}) {
  const env = {
    ...process.env,
    AGENTICLOOP_TEST_ARGS: JSON.stringify(args),
    AGENTICLOOP_TEST_TARGET: target,
  };
  if (!withKey) {
    return runProcess(process.execPath, [boundaryWrapper], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  }
  const configDir = mkdtempSync(join(tmpBase, 'protected-config-'));
  const configPath = join(configDir, 'config.json');
  const config = {
    kind: 'agenticloop.protected-host-config',
    schemaVersion: 1,
    adapterId,
    keyId,
    targetRepositoryIdentity: targetRepositoryIdentity(target),
    operatorTrustRoot,
    assertedPath: null,
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    ...configOverrides,
  };
  writeFileSync(configPath, configBytes ?? JSON.stringify(config), { mode: 0o600 });
  const descriptor = openSync(configPath, 'r');
  try {
    return await runProcess(process.execPath, [boundaryWrapper], {
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
      env,
    });
  } finally {
    closeSync(descriptor);
  }
}

async function completedAudits(target) {
  const status = await runSource(['audit', 'status', 'AUD-001', '--json', '--target', target]);
  return JSON.parse(status.stdout).completed_audits;
}

describe('protected host boundary', { concurrency: 4 }, () => {
  it('fails closed when the protected channel is absent', async () => {
    const fx = await setup('boundary-absent');
    const result = await fx.run({ withKey: false });
    assert.equal(result.status, 9, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /boundary unavailable/);
    assert.match(result.stderr, /no readable configuration on file descriptor 3/);
    assert.equal(await completedAudits(fx.target), 0);
  });

  const MALFORMED_CHANNELS = [
    ['an empty descriptor', Buffer.alloc(0), /carried no configuration/],
    ['arbitrary bytes', Buffer.from('not json'), /not valid JSON/],
    ['an open schema', Buffer.from('{"kind":"agenticloop.protected-host-config","schemaVersion":1,"extra":true}'), /closed schema/],
  ];

  it('fails closed for every malformed protected channel', async () => {
    const fx = await setup('boundary-malformed');
    for (const [label, bytes, pattern] of MALFORMED_CHANNELS) {
      const result = await fx.run({ withKey: 'variant', configBytes: bytes });
      assert.equal(result.status, 9, `${label}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /boundary unavailable/, label);
      assert.match(result.stderr, pattern, label);
    }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongAlgorithm = await fx.run({
      withKey: 'variant',
      configOverrides: { privateKey: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    });
    assert.equal(wrongAlgorithm.status, 9, `${wrongAlgorithm.stdout}${wrongAlgorithm.stderr}`);
    assert.match(wrongAlgorithm.stderr, /must be an ed25519 private key/);
    assert.equal(await completedAudits(fx.target), 0);
  });

  it('refuses a key the operator never pinned for the named adapter', async () => {
    const fx = await setup('boundary-stranger');
    const stranger = generateHostSigningKey();
    const result = await fx.run({
      withKey: 'variant',
      configOverrides: { privateKey: stranger.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    });
    assert.equal(result.status, 9, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /boundary unavailable/);
    assert.equal(await completedAudits(fx.target), 0);
  });

  it('registers no agent-callable signing command or alternate signing seam', async () => {
    const help = await runSource(['help']);
    assert.equal(help.status, 0, help.stderr);
    const surface = help.stdout + (await runSource(['--help'])).stdout;
    for (const forbidden of [/\bsign\b/i, /protected-host/i, /host-boundary/i]) {
      assert.doesNotMatch(surface, forbidden, 'the protected boundary must not be reachable as a CLI subcommand');
    }
    const attempted = await runSource(['protected-host-boundary']);
    assert.notEqual(attempted.status, 0);

    const boundaryModule = await import('../src/protected-host-boundary.js');
    assert.equal(typeof boundaryModule.loadProtectedAuditorReturnVerifier, 'function');
    assert.equal(boundaryModule.PROTECTED_KEY_DESCRIPTOR, 3);
    assert.equal(boundaryModule.readProtectedHostSigningKey, undefined);
    assert.equal(boundaryModule.createInheritedDescriptorHostBoundary, undefined);
  });

  it('refuses caller-selected security configuration and a cross-target protected envelope', async () => {
    const boundaryModule = await import('../src/protected-host-boundary.js');
    const injected = boundaryModule.loadProtectedAuditorReturnVerifier({
      target: join(tmpBase, 'caller-selected-target'),
      operatorTrustRoot: join(tmpBase, 'caller-selected-root'),
      readKey: () => generateHostSigningKey().privateKey,
    });
    assert.equal(injected.ok, false);
    assert.match(injected.errors.join('\n'), /accepts only the target option/);

    const fx = await setup('boundary-cross-target');
    const result = await fx.run({
      withKey: 'variant',
      configOverrides: { targetRepositoryIdentity: targetRepositoryIdentity(join(tmpBase, 'different-target')) },
    });
    assert.equal(result.status, 9, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /does not match the target repository/);
  });

  it('keeps independent protected boundary workflows live under concurrency', { timeout: 120000 }, async () => {
    const [first, second] = await Promise.all([
      setup('boundary-overlap-first'),
      setup('boundary-overlap-second'),
    ]);
    const [firstResult, secondResult] = await Promise.all([first.run(), second.run()]);
    assert.equal(firstResult.status, 0, `${firstResult.stdout}${firstResult.stderr}`);
    assert.equal(secondResult.status, 0, `${secondResult.stdout}${secondResult.stderr}`);
    assert.equal(await completedAudits(first.target), 1);
    assert.equal(await completedAudits(second.target), 1);
  });
});
