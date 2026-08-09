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
import { dirname, join, delimiter, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createDispatchFixture,
  git,
  readyReturn,
  repositoryEvidence,
} from './helpers/dispatch-fixture.js';
import { createTestHostTrust, writeHostTrustStore } from './helpers/host-trust-fixture.js';
import { generateHostSigningKey, targetRepositoryIdentity } from '../src/host-trust.js';
import { createAuditorReturnReceipt } from '../src/auditor-return-receipt.js';
import { auditorReturnReportDigest } from '../src/audit-report-schema.js';

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
  assert.ok(
    existsSync(join(packedRoot, 'scripts', 'sign-blocked-authority.mjs')),
    'packed canonical blocked-authority signer is missing'
  );
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
 * Run an installed command behind a real protected host boundary.
 *
 * The boundary's private key is handed to the child on file descriptor 3 and
 * never appears in the environment, the argv, or the target repository - the
 * same discipline a real host wrapper must follow.
 */
function runPackedWithBoundary(args, { operatorTrustRoot, adapterId, keyId, privateKey }) {
  const wrapper = join(tmpBase, 'packed-boundary-wrapper.mjs');
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
  const keyPath = join(tmpBase, 'packed-boundary.pk8');
  writeFileSync(keyPath, privateKey.export({ format: 'der', type: 'pkcs8' }), { mode: 0o600 });
  const keyDescriptor = openSync(keyPath, 'r');
  try {
    return spawnSync(process.execPath, [wrapper], {
      encoding: 'utf8',
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
  }
}

/**
 * Run an installed command through the *packaged* reference host integration.
 *
 * Unlike `runPackedWithAuditorVerifier`, this wrapper writes no signing logic of
 * its own: it imports `agenticloop/protected-host-boundary` from the installed
 * tarball and hands it only the target being operated on. Descriptor 3 carries
 * the closed host-owned configuration envelope, including the signing key,
 * pinned trust root, adapter registration, and target identity. None of those
 * security inputs appears in argv or the environment.
 *
 * `withKey: false` spawns the identical wrapper with no descriptor 3 at all, so
 * the negative case exercises the real missing-channel path.
 */
function runPackedThroughPackagedBoundary(args, {
  target, operatorTrustRoot, adapterId, keyId, privateKey,
  withKey = true, configBytes = null, configOverrides = {},
}) {
  const wrapper = join(tmpBase, 'packed-packaged-boundary-wrapper.mjs');
  if (!existsSync(wrapper)) {
    writeFileSync(wrapper, [
      `import { runCli } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'cli-main.js')).href)};`,
      `import { loadProtectedAuditorReturnVerifier } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'protected-host-boundary.js')).href)};`,
      'const loaded = loadProtectedAuditorReturnVerifier({',
      '  target: process.env.AGENTICLOOP_TEST_TARGET,',
      '});',
      'if (!loaded.ok) {',
      '  process.stderr.write(`boundary unavailable: ${loaded.errors.join("; ")}\\n`);',
      '  process.exit(9);',
      '}',
      'process.exitCode = await runCli(JSON.parse(process.env.AGENTICLOOP_TEST_ARGS), {',
      '  auditProvenanceVerifier: loaded.verifier,',
      '});',
      '',
    ].join('\n'), 'utf8');
  }
  const env = {
    ...process.env,
    AGENTICLOOP_TEST_ARGS: JSON.stringify(args),
    AGENTICLOOP_TEST_TARGET: target,
  };
  if (!withKey) {
    return spawnSync(process.execPath, [wrapper], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  }
  const configPath = join(tmpBase, `packed-packaged-boundary-${withKey === true ? 'valid' : 'variant'}.json`);
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
  const configDescriptor = openSync(configPath, 'r');
  try {
    return spawnSync(process.execPath, [wrapper], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', configDescriptor],
      env,
    });
  } finally {
    closeSync(configDescriptor);
  }
}

function runPackedWithAuditorVerifier(args, { target, operatorTrustRoot, adapterId, keyId, now, privateKey }) {
  const wrapper = join(tmpBase, 'packed-auditor-host-wrapper.mjs');
  if (!existsSync(wrapper)) {
    writeFileSync(wrapper, [
      `import { runCli } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'cli-main.js')).href)};`,
      `import { loadAuditorReturnReceiptVerifier } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'auditor-return-receipt.js')).href)};`,
      `import { HOST_TRUST_BOUNDARY_RESPONSE_KIND, HOST_TRUST_BOUNDARY_SCHEMA_VERSION, hostTrustBoundarySignaturePayload, signHostPayload } from ${JSON.stringify(pathToFileURL(join(packedRoot, 'src', 'host-trust.js')).href)};`,
      'import { createPrivateKey } from "node:crypto";',
      'import { readFileSync } from "node:fs";',
      'const boundaryKey = createPrivateKey({ key: readFileSync(3), format: "der", type: "pkcs8" });',
      'const loaded = loadAuditorReturnReceiptVerifier({',
      '  target: process.env.AGENTICLOOP_TEST_TARGET,',
      '  operatorTrustRoot: process.env.AGENTICLOOP_TEST_OPERATOR_ROOT,',
      '  adapterId: process.env.AGENTICLOOP_TEST_ADAPTER,',
      '  now: Number(process.env.AGENTICLOOP_TEST_NOW),',
      '  protectedBoundary: challenge => {',
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
      'if (!loaded.ok) throw new Error(loaded.errors.join("; "));',
      'process.exitCode = await runCli(JSON.parse(process.env.AGENTICLOOP_TEST_ARGS), {',
      '  auditProvenanceVerifier: loaded.verifier,',
      '});',
      '',
    ].join('\n'), 'utf8');
  }
  const keyPath = join(tmpBase, 'packed-auditor-boundary.pk8');
  writeFileSync(keyPath, privateKey.export({ format: 'der', type: 'pkcs8' }), { mode: 0o600 });
  const keyDescriptor = openSync(keyPath, 'r');
  try {
    return spawnSync(process.execPath, [wrapper], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', keyDescriptor],
      env: {
        ...process.env,
        AGENTICLOOP_TEST_ARGS: JSON.stringify(args),
        AGENTICLOOP_TEST_TARGET: target,
        AGENTICLOOP_TEST_OPERATOR_ROOT: operatorTrustRoot,
        AGENTICLOOP_TEST_ADAPTER: adapterId,
        AGENTICLOOP_TEST_KEY_ID: keyId,
        AGENTICLOOP_TEST_NOW: String(now),
      },
    });
  } finally {
    closeSync(keyDescriptor);
  }
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

    document.schemaVersion = 2;
    document.adapters = [];
    document.authorities = [{
      authorityId: 'packed-redelegation-root',
      authorityKind: 'blocked_result_redelegation',
      keyId: 'packed-redelegation-key-1',
      algorithm: 'ed25519',
      publicKey: publicKeyBase64,
      issuer: { ownerKind: 'workflow_role', ownerId: 'orchestrator' },
      revokedRecordIds: [],
    }];
    writeFileSync(operatorPath, `${JSON.stringify(document)}\n`, 'utf8');
    const authorityStore = trustModule.loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: operatorPath,
    });
    assert.equal(authorityStore.ok, true, authorityStore.errors.join('\n'));
    assert.equal(
      authorityStore.authorities['packed-redelegation-root'].authorityKind,
      'blocked_result_redelegation'
    );
  });

  /**
   * Adversarial cases run against the *installed* modules.
   *
   * Each corresponds to a defect the source-tree regressions cover; repeating
   * them here proves the shipped tarball carries the corrected behavior rather
   * than only the working tree.
   */
  describe('installed adversarial boundary and freshness cases', () => {
    it('does not freeze challenge expiry for a now-only verifier caller', async () => {
      const trustModule = await import(pathToFileURL(join(packedRoot, 'src', 'host-trust.js')).href);
      const target = mkdtempSync(join(tmpBase, 'packed-nowonly-target-'));
      const operatorRoot = mkdtempSync(join(tmpBase, 'packed-nowonly-operator-'));
      const trust = createTestHostTrust({ target });
      const storePath = writeHostTrustStore(operatorRoot, trust);

      const pinned = Date.parse('2020-01-01T00:00:00.000Z');
      let observed = null;
      const loaded = trustModule.loadHostTrustStore(target, {
        operatorTrustRoot: operatorRoot,
        assertedPath: storePath,
        now: pinned,
        protectedBoundary: challenge => {
          observed = challenge;
          const response = {
            kind: trustModule.HOST_TRUST_BOUNDARY_RESPONSE_KIND,
            schemaVersion: trustModule.HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
            adapterId: trust.adapterId, keyId: trust.keyId,
            challengeNonce: challenge.nonce, signature: null,
          };
          response.signature = trustModule.signHostPayload(
            trustModule.hostTrustBoundarySignaturePayload(challenge, response), trust.privateKey
          );
          return response;
        },
      });
      assert.equal(loaded.ok, true, loaded.errors?.join('; '));
      assert.notEqual(Date.parse(observed.issuedAt), pinned, 'the freshness instant must not become the loader clock');
    });

    it('refuses a delayed challenge response through the installed loader', async () => {
      const trustModule = await import(pathToFileURL(join(packedRoot, 'src', 'host-trust.js')).href);
      const target = mkdtempSync(join(tmpBase, 'packed-delayed-target-'));
      const operatorRoot = mkdtempSync(join(tmpBase, 'packed-delayed-operator-'));
      const trust = createTestHostTrust({ target });
      const storePath = writeHostTrustStore(operatorRoot, trust);
      const issuedAt = Date.parse('2026-08-08T12:00:00.000Z');
      let reads = 0;
      const loaded = trustModule.loadHostTrustStore(target, {
        operatorTrustRoot: operatorRoot,
        assertedPath: storePath,
        clock: () => issuedAt,
        monotonicClock: () => (reads++ === 0 ? 1_000 : 1_000 + trustModule.HOST_TRUST_CHALLENGE_TTL_MS),
        protectedBoundary: challenge => {
          const response = {
            kind: trustModule.HOST_TRUST_BOUNDARY_RESPONSE_KIND,
            schemaVersion: trustModule.HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
            adapterId: trust.adapterId, keyId: trust.keyId,
            challengeNonce: challenge.nonce, signature: null,
          };
          response.signature = trustModule.signHostPayload(
            trustModule.hostTrustBoundarySignaturePayload(challenge, response), trust.privateKey
          );
          return response;
        },
      });
      assert.equal(loaded.ok, false);
      assert.equal(loaded.state, 'unsupported_boundary');
    });

    it('refuses a non-finite receipt verification clock', async () => {
      const receipts = await import(pathToFileURL(join(packedRoot, 'src', 'auditor-return-receipt.js')).href);
      const schema = await import(pathToFileURL(join(packedRoot, 'src', 'audit-report-schema.js')).href);
      const target = mkdtempSync(join(tmpBase, 'packed-nanclock-target-'));
      const trust = createTestHostTrust({ target });
      const report = {
        report_schema: 'auditor_report_v1', producer: { roleId: 'auditor' },
        artifact: `commit:${'a'.repeat(40)}`, covered_tasks: ['T-001'],
        invocation: { mode: 'host_subagent', reference: 'packed-nanclock-ref', provenance: 'verified', receipt: null },
        perspectives: Object.fromEntries(
          ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
            .map(key => [key, `${key} body.`])
        ),
        assessment: 'Consolidated.', evidence_checked: 'npm test', verdict: 'certified', findings: [],
      };
      const context = {
        target, trustedAdapter: trust.adapter, role: 'auditor',
        invocationReference: report.invocation.reference, invocationMode: report.invocation.mode,
        workUnit: 'milestone:M00', candidateArtifact: report.artifact,
        coveredTasks: report.covered_tasks, reportDigest: schema.auditorReturnReportDigest(report),
      };
      const stale = receipts.createAuditorReturnReceipt({
        receiptId: 'packed-nanclock-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
        targetRepository: trust.repositoryIdentity,
        invocationReference: context.invocationReference, invocationMode: context.invocationMode,
        workUnit: context.workUnit, candidateArtifact: context.candidateArtifact,
        coveredTasks: context.coveredTasks, reportDigest: context.reportDigest,
        issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:01:00.000Z',
      }, trust.privateKey);
      for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, 'not-a-time']) {
        const result = receipts.verifyAuditorReturnReceipt(stale, { ...context, now: clock });
        assert.equal(result.verified, false, String(clock));
        assert.equal(result.state, 'stale', String(clock));
      }

      // An old receipt whose expiry was pushed far into the future is refused
      // by the declared-validity policy, not admitted because it "has not
      // expired yet".
      const farFuture = receipts.createAuditorReturnReceipt({
        receiptId: 'packed-farfuture-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
        targetRepository: trust.repositoryIdentity,
        invocationReference: context.invocationReference, invocationMode: context.invocationMode,
        workUnit: context.workUnit, candidateArtifact: context.candidateArtifact,
        coveredTasks: context.coveredTasks, reportDigest: context.reportDigest,
        issuedAt: '2026-08-01T12:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
      }, trust.privateKey);
      const refused = receipts.verifyAuditorReturnReceipt(farFuture, {
        ...context, now: Date.parse('2026-08-08T12:00:00.000Z'),
      });
      assert.equal(refused.verified, false);
      assert.equal(refused.state, 'stale');
      assert.equal(typeof receipts.AUDITOR_RECEIPT_MAX_VALIDITY_MS, 'number');
    });

    it('refuses noncanonical and suffixed signature encodings', async () => {
      const trustModule = await import(pathToFileURL(join(packedRoot, 'src', 'host-trust.js')).href);
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const { privateKey, publicKey } = trustModule.generateHostSigningKey();
      const payload = { probe: true };
      const signature = trustModule.signHostPayload(payload, privateKey);
      const body = signature.slice('ed25519:'.length);
      assert.equal(trustModule.verifyHostPayload(payload, signature, publicKey), true);
      assert.equal(body.length, 88);

      const tailIndex = alphabet.indexOf(body[85]);
      const noncanonical = `ed25519:${body.slice(0, 85)}${alphabet[tailIndex + 1]}==`;
      for (const [label, text] of [
        ['suffixed', `${signature}:ignored`],
        ['noncanonical', noncanonical],
        ['unpadded', `ed25519:${body.slice(0, 86)}`],
        ['over-padded', `${signature}=`],
        ['wrong length', `ed25519:${Buffer.from(body, 'base64').subarray(0, 63).toString('base64')}`],
        ['wrong algorithm', `ed448:${body}`],
      ]) {
        assert.equal(trustModule.verifyHostPayload(payload, text, publicKey), false, label);
      }
    });

    it('refuses to prepare an asserted report for host signing', async () => {
      const schema = await import(pathToFileURL(join(packedRoot, 'src', 'audit-report-schema.js')).href);
      const base = {
        report_schema: 'auditor_report_v1', producer: { roleId: 'auditor' },
        artifact: `commit:${'a'.repeat(40)}`, covered_tasks: ['T-001'],
        perspectives: Object.fromEntries(
          ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
            .map(key => [key, `${key} body.`])
        ),
        assessment: 'Consolidated.', evidence_checked: 'npm test', verdict: 'certified', findings: [],
      };
      const asserted = schema.prepareAuditorReturnReportForSigning({
        ...base,
        invocation: { mode: 'host_subagent', reference: 'packed-asserted-ref', provenance: 'asserted' },
      });
      assert.equal(asserted.ok, false);
      assert.equal(asserted.report, null);
      assert.equal(asserted.digest, null);
      assert.match(asserted.errors[0], /invocation\.provenance must be 'verified'/);

      const verified = schema.prepareAuditorReturnReportForSigning({
        ...base,
        invocation: { mode: 'host_subagent', reference: 'packed-verified-ref', provenance: 'verified' },
      });
      assert.equal(verified.ok, true, verified.errors.join('; '));
      assert.equal(verified.report.invocation.receipt, null);
    });

    it('returns one canonical typed envelope for an unsupported installed task backend', () => {
      const target = mkdtempSync(join(tmpBase, 'packed-unsupported-backend-'));
      const scaffolded = runPacked(['init', '--target', target, '--adapter', 'opencode']);
      assert.equal(scaffolded.status, 0, `${scaffolded.stdout}${scaffolded.stderr}`);
      const projectPath = join(target, '.agenticloop', 'project.md');
      writeFileSync(
        projectPath,
        readFileSync(projectPath, 'utf8').replace(/^task_backend:.*$/m, 'task_backend: jira'),
        'utf8'
      );
      for (const sub of [['list'], ['lint'], ['status', 'T-001', 'blocked']]) {
        const result = runPacked(['task', ...sub, '--json', '--target', target]);
        assert.notEqual(result.status, 0, `${sub[0]}: ${result.stdout}${result.stderr}`);
        const envelope = JSON.parse(result.stdout);
        assert.equal(envelope.kind, 'agenticloop.validation-result', sub[0]);
        assert.equal(envelope.command, `task ${sub[0]}`, sub[0]);
        assert.equal(envelope.diagnostics[0].code, 'verification.context.malformed', sub[0]);
        assert.match(envelope.diagnostics[0].message, /task backend 'jira'.*is not supported/, sub[0]);
      }
    });
  });

  it('rejects installed Auditor receipt tampering and liveness after signature-first verification', async () => {
    const verifierModule = await import(pathToFileURL(join(packedRoot, 'src', 'auditor-return-receipt.js')).href);
    const target = join(tmpBase, 'packed-auditor-verifier-target');
    mkdirSync(target, { recursive: true });
    const trust = createTestHostTrust({ target });
    const report = {
      report_schema: 'auditor_report_v1', producer: { roleId: 'auditor' },
      artifact: `commit:${'a'.repeat(40)}`, covered_tasks: ['T-001'],
      invocation: { mode: 'host_subagent', reference: 'packed-verifier-ref', provenance: 'verified', receipt: null },
      perspectives: Object.fromEntries(
        ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
          .map(key => [key, `${key} body.`])
      ),
      assessment: 'Consolidated.', evidence_checked: 'npm test', verdict: 'certified', findings: [],
    };
    const context = {
      target, trustedAdapter: trust.adapter, role: 'auditor',
      invocationReference: report.invocation.reference, invocationMode: report.invocation.mode,
      workUnit: 'milestone:M00', candidateArtifact: report.artifact,
      coveredTasks: report.covered_tasks, reportDigest: auditorReturnReportDigest(report),
      now: Date.parse('2026-08-08T12:00:00.000Z'),
    };
    const receipt = createAuditorReturnReceipt({
      receiptId: 'packed-verifier-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: context.invocationReference, invocationMode: context.invocationMode,
      workUnit: context.workUnit, candidateArtifact: context.candidateArtifact,
      coveredTasks: context.coveredTasks, reportDigest: context.reportDigest,
      issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
    }, trust.privateKey);
    assert.equal(verifierModule.verifyAuditorReturnReceipt(receipt, context).verified, true);
    for (const patch of [
      { adapterId: 'wrong.adapter' },
      { targetRepository: 'file:/wrong-target' },
      { producerRole: 'engineer' },
      { reportDigest: `sha256:agenticloop.auditor-return-report.v1:${'b'.repeat(64)}` },
    ]) {
      const tampered = { ...structuredClone(receipt), ...patch };
      const result = verifierModule.verifyAuditorReturnReceipt(tampered, context);
      assert.equal(result.verified, false);
      assert.equal(result.state, 'untrusted');
    }
    const forgedExpired = structuredClone(receipt);
    forgedExpired.expiresAt = '2026-08-08T11:00:00.000Z';
    const forged = verifierModule.verifyAuditorReturnReceipt(forgedExpired, context);
    assert.equal(forged.state, 'untrusted', 'forged expiry must not be classified as authentic stale evidence');
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

  it('emits a committable decomposition source from the installed read-only producer', async () => {
    const fixture = await createDispatchFixture(tmpBase, 'packed-decomposition');
    const baseTree = fixture.readiness.evidence.base.identity.slice('git-tree:'.length);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf-8' });
    assert.equal(head.status, 0, head.stderr);
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: fixture.root, encoding: 'utf-8' }).stdout;

    const produced = runPacked([
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'packed-work-unit',
      '--source-ref', '.agenticloop/decompositions/T-001-packed.json',
      '--source-revision', `git-commit:${String(head.stdout).trim()}`,
      '--base', baseTree,
      '--dependencies', 'dependencies.json',
      '--json',
      '--target', fixture.root,
    ]);
    assert.equal(produced.status, 0, produced.stderr);
    const decomposition = JSON.parse(produced.stdout);
    assert.equal(decomposition.kind, 'agenticloop.decomposition-provenance');
    assert.equal(decomposition.scan.inventory.complete, true);
    assert.equal(decomposition.scan.inventory.enumeration.enumerator, 'agenticloop.files-task-directory.v1');
    assert.equal(decomposition.scan.inventory.enumeration.completion, 'exhaustive');
    assert.ok(decomposition.scan.readinessContext.digest);

    // The installed producer is read-only: it writes nothing, stages nothing,
    // and leaves the target worktree exactly as it found it.
    const after = spawnSync('git', ['status', '--porcelain'], { cwd: fixture.root, encoding: 'utf-8' }).stdout;
    assert.equal(after, before);

    // The installed validator accepts the source the installed producer emitted.
    const scan = await import(pathToFileURL(join(packedRoot, 'src', 'parallel-scan.js')).href);
    assert.equal(scan.validateParallelScanRecord(decomposition.scan).ok, true);
  });

  it('produces an authoritative paginated GitHub inventory through the installed task family', async () => {
    const fixture = await createDispatchFixture(tmpBase, 'packed-github-decomposition');
    const projectPath = join(fixture.root, '.agenticloop', 'project.md');
    writeFileSync(projectPath, readFileSync(projectPath, 'utf8').replace('task_backend: files', 'task_backend: github'), 'utf8');
    const task = readFileSync(fixture.taskPath, 'utf8');
    const fake = installFakeGh(tmpBase, {
      repo: 'owner/repository',
      issuePages: [
        [{ number: 71, state: 'open', title: 'Task T-001', body: task, labels: [{ name: 'task:T-001' }] }],
        [],
      ],
    });
    const baseTree = fixture.readiness.evidence.base.identity.slice('git-tree:'.length);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    const produced = runPacked([
      'task', 'prepare-decomposition', 'T-001', '--work-unit', 'packed-github-work-unit',
      '--source-ref', '.agenticloop/decompositions/T-001-packed-github.json',
      '--source-revision', `git-commit:${head}`, '--base', baseTree,
      '--dependencies', 'dependencies.json', '--repo', 'owner/repository',
      '--json', '--target', fixture.root,
    ], { env: fake.env });
    assert.equal(produced.status, 0, `${produced.stdout}${produced.stderr}`);
    const decomposition = JSON.parse(produced.stdout);
    assert.equal(decomposition.scan.workUnit.backend, 'github');
    assert.equal(decomposition.scan.inventory.enumeration.coverage.pageCount, 2);
    assert.equal(decomposition.scan.inventory.enumeration.coverage.discovered, 1);
    assert.equal(decomposition.scan.inventory.enumeration.coverage.returned, 1);
    const calls = readFileSync(fake.logPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(calls.some(args => args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')));
  });

  it('exercises installed corrective capture, drift, diagnostic, and required-check contracts', async () => {
    const dispatch = await import(pathToFileURL(join(packedRoot, 'src', 'dispatch-envelope.js')).href);
    const handoff = await import(pathToFileURL(join(packedRoot, 'src', 'host-handoff.js')).href);
    const checks = await import(pathToFileURL(join(packedRoot, 'src', 'required-checks.js')).href);
    const taskEvidence = await import(pathToFileURL(join(packedRoot, 'src', 'task-evidence-contract.js')).href);
    const fixture = await createDispatchFixture(tmpBase, 'packed-corrective-contracts');
    const prepared = dispatch.prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.ok(prepared.packet.assignment.degradedEnforcementReports.length > 0);
    assert.ok(prepared.packet.assignment.degradedEnforcementReports.every(report =>
      report.diagnosticCode === 'capability.enforcement.degraded' &&
      report.declarationDigest === prepared.packet.assignment.hostRoleCapability.digest
    ));
    assert.ok(prepared.validation.warningDiagnostics.some(diagnostic =>
      diagnostic.code === 'capability.enforcement.degraded'
    ));
    const fabricatedReportPacket = structuredClone(prepared.packet);
    fabricatedReportPacket.assignment.degradedEnforcementReports[0].enforcement = 'enforced';
    fabricatedReportPacket.digest = dispatch.dispatchPreparationDigest(fabricatedReportPacket);
    assert.equal(dispatch.validateDispatchPreparation(fabricatedReportPacket, fixture.options).ok, false);

    const digest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
    const provider = (packet, roleReturn, evidence) => {
      const producerReceipt = handoff.createHostHandoffReceipt({
        adapterId: fixture.trust.adapterId,
        keyId: fixture.trust.keyId,
        packet,
        roleReturn,
        observedProducerRole: packet.assignment.roleId,
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
    const returnHelp = runPacked(['task', 'verify-return', '--help']);
    assert.equal(returnHelp.status, 0, returnHelp.stderr);
    for (const option of [
      '--resume-owner',
      '--redelegation-authority',
      '--recovery-request',
      '--human-disposition',
      '--host-trust-store',
    ]) assert.match(returnHelp.stdout, new RegExp(option));
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

    // Every generated activation surface stays fail-closed *and* routes the
    // operator to the exact plugin-free command. The two properties travel
    // together: an artifact that only blocked would make the toolkit unusable,
    // and one that offered a shortcut would make the block meaningless.
    const opencodeCommand = readFileSync(join(target, '.opencode', 'commands', 'agenticloop.md'), 'utf8');
    assert.match(opencodeCommand, /Activation adapter: `opencode\.command\.positional\.v1`\./);
    assert.match(opencodeCommand, /Activation capture capability: `unsupported`\./);
    assert.match(opencodeCommand, /npx agenticloop activate T-016 T-017/);
    assert.match(opencodeCommand, /outside the agent session|in the operator's own terminal/i);
    assert.match(opencodeCommand, /operator_confirmed/);
    assert.match(opencodeCommand, /session_reported/);
    assert.match(opencodeCommand, /not host-authenticated/i);
    assert.doesNotMatch(opencodeCommand, /\$ARGUMENTS|\$1|\$2/);
    assert.deepEqual(slots.validateFilledAdapterSlots(opencodeCommand, '.opencode/commands/agenticloop.md'), []);

    const validated = runPacked(['validate', '--target', target]);
    assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
  });

  it('ships the activation and host-trust commands in the packed CLI', () => {
    for (const path of ['src/activation-cli.js', 'src/activation-grant.js', 'src/activation-store.js',
      'src/activation-trust.js', 'src/activation-policy.js', 'src/activation-resolution.js',
      'src/host-trust-cli.js']) {
      assert.ok(existsSync(join(packedRoot, ...path.split('/'))), `${path} must be shipped`);
    }
    const help = runPacked(['help', 'activate']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /npx agenticloop activate T-016 T-017/);
    assert.match(help.stdout, /no --yes flag/i);

    // The packed CLI refuses this grade non-interactively, from a real process.
    const target = mkdtempSync(join(tmpBase, 'packed-activate-'));
    const refused = runPacked(['activate', 'T-001', '--target', target, '--json']);
    assert.equal(refused.status, 1);
    assert.doesNotMatch(refused.stdout, /"grantId":\s*"grant:/);
    assert.equal(existsSync(join(target, '.agenticloop', 'activations')), false);
  });

  it('ships docs/cli-reference.md', () => {
    assert.ok(existsSync(join(packedRoot, 'docs', 'cli-reference.md')),
      'docs/cli-reference.md must be shipped in the packed package');
  });

  it('ships the runtime transition module in the package', () => {
    assert.ok(existsSync(join(packedRoot, 'src', 'transition-contract.js')),
      'src/transition-contract.js must be shipped in the packed package');
  });

  it('resolves the documented verifier subpaths and keeps deep imports and data files reachable', async () => {
    // The package declares `exports`, so this proves the stable subpaths
    // resolve *and* that declaring them did not restrict anything that already
    // worked: the documented `agenticloop/src/...` deep imports, arbitrary
    // shipped modules, and non-code data files must all stay reachable.
    const prefix = join(tmpBase, 'prefix');
    const consumer = join(tmpBase, 'exports-consumer');
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'exports-consumer', private: true, type: 'module',
    }), 'utf8');
    const installed = npm([
      'install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund',
      '--offline', join(prefix, 'node_modules', 'agenticloop'),
    ]);
    assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);

    const probe = join(consumer, 'probe.mjs');
    writeFileSync(probe, [
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import { createRequire } from "node:module";',
      '// Stable documented subpaths.',
      'const receipts = await import("agenticloop/auditor-return-receipt");',
      'const schema = await import("agenticloop/audit-report-schema");',
      'const trust = await import("agenticloop/host-trust");',
      'assert.equal(typeof receipts.createAuditorReturnReceipt, "function");',
      'assert.equal(typeof receipts.loadAuditorReturnReceiptVerifier, "function");',
      'assert.equal(typeof receipts.verifyAuditorReturnReceipt, "function");',
      'assert.equal(typeof receipts.AUDITOR_RECEIPT_FUTURE_SKEW_MS, "number");',
      'assert.equal(typeof schema.prepareAuditorReturnReportForSigning, "function");',
      'assert.equal(typeof schema.parseAuditorWireReport, "function");',
      'assert.equal(typeof receipts.AUDITOR_RECEIPT_MAX_VALIDITY_MS, "number");',
      'assert.equal(typeof trust.HOST_TRUST_CHALLENGE_TTL_MS, "number");',
      'assert.equal(typeof trust.HOST_SIGNATURE_BYTE_LENGTH, "number");',
      '// Universal activation: the grant/binding contract and the policy model.',
      'const grants = await import("agenticloop/activation-grant");',
      'assert.equal(typeof grants.createActivationGrant, "function");',
      'assert.equal(typeof grants.createTaskActivationBinding, "function");',
      'assert.equal(typeof grants.resolveTaskActivationBinding, "function");',
      'assert.deepEqual([...grants.ACTIVATION_ASSURANCE_ORDER], ["operator_confirmed", "host_signed"]);',
      'assert.deepEqual([...grants.RETURN_ASSURANCE_ORDER], ["session_reported", "host_receipt"]);',
      'assert.match(grants.ACTIVATION_ASSURANCE_LIMITATIONS.operator_confirmed, /not an isolated host signer/);',
      'assert.match(grants.RETURN_ASSURANCE_LIMITATIONS.session_reported, /NOT host-authenticated/);',
      '// The packaged module exposes no signing entry point of its own.',
      'assert.equal(grants.signActivationGrant, undefined);',
      'const policy = await import("agenticloop/activation-policy");',
      'assert.deepEqual(policy.MODE_MINIMUMS.standard, { activation: "operator_confirmed", return: "session_reported" });',
      'assert.deepEqual(policy.MODE_MINIMUMS.hardened, { activation: "host_signed", return: "host_receipt" });',
      'assert.equal(typeof policy.resolveActivationPolicy, "function");',
      'const deepStore = await import("agenticloop/src/activation-store.js");',
      'assert.equal(deepStore.ACTIVATION_STORE_ROOT, ".agenticloop/activations");',
      '// The shipped reference host integration for the protected boundary.',
      'const boundary = await import("agenticloop/protected-host-boundary");',
      'assert.equal(typeof boundary.loadProtectedAuditorReturnVerifier, "function");',
      'assert.equal(boundary.createInheritedDescriptorHostBoundary, undefined);',
      'assert.equal(boundary.readProtectedHostSigningKey, undefined);',
      'assert.equal(boundary.PROTECTED_KEY_DESCRIPTOR, 3);',
      'assert.equal(boundary.PROTECTED_HOST_CONFIG_SCHEMA_VERSION, 1);',
      'const deepBoundary = await import("agenticloop/src/protected-host-boundary.js");',
      'assert.equal(deepBoundary.loadProtectedAuditorReturnVerifier, boundary.loadProtectedAuditorReturnVerifier);',
      '// The package root entry.',
      'const root = await import("agenticloop");',
      'assert.equal(typeof root.runCli, "function");',
      '// Previously documented deep imports still resolve.',
      'const deep = await import("agenticloop/src/auditor-return-receipt.js");',
      'assert.equal(deep.createAuditorReturnReceipt, receipts.createAuditorReturnReceipt);',
      'const deepSchema = await import("agenticloop/src/audit-report-schema.js");',
      'assert.equal(deepSchema.prepareAuditorReturnReportForSigning, schema.prepareAuditorReturnReportForSigning);',
      'await import("agenticloop/src/transition-contract.js");',
      'await import("agenticloop/src/cli-main.js");',
      '// Shipped data files and Markdown assets stay reachable.',
      'const require_ = createRequire(import.meta.url);',
      'const configPath = require_.resolve("agenticloop/config.json");',
      'assert.ok(JSON.parse(readFileSync(configPath, "utf8")).adapters);',
      'assert.ok(readFileSync(require_.resolve("agenticloop/AGENTIC_LOOP.md"), "utf8").length > 0);',
      'assert.ok(readFileSync(require_.resolve("agenticloop/agents/engineer.md"), "utf8").length > 0);',
      'assert.ok(readFileSync(require_.resolve("agenticloop/package.json"), "utf8").length > 0);',
      'console.log("ok");',
      '',
    ].join('\n'), 'utf8');

    const ran = spawnSync(process.execPath, [probe], { encoding: 'utf8', cwd: consumer });
    assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /ok/);
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
  /** The real installed packet, shared by the budget and measurement tests. */
  let packetBudget = null;

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
      producer: { roleId: 'auditor' },
      artifact,
      covered_tasks: coveredTasks,
      invocation: { mode: 'host_subagent', reference, provenance: 'verified', receipt: `auditor-receipt-${reference}` },
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

  it('fails closed for Auditor reports without a protected host receipt verifier', () => {
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
    assert.equal(fromFile.status, 1);
    assert.match(fromFile.stderr, /requires a host receipt verifier/);
    assert.match(fromFile.stderr, /Auditor resume packet:/);

    const fromStdin = spawnSync(process.execPath, [
      packedBin, 'audit', 'report', 'AUD-001', '--stdin', '--target', target,
    ], { encoding: 'utf-8', input: JSON.stringify(wireReport(artifact, ['T-001'], 'packed-ref-2')) });
    assert.equal(fromStdin.status, 1);
    assert.match(fromStdin.stderr, /requires a host receipt verifier/);

    const status = runPacked(['audit', 'status', 'AUD-001', '--json', '--target', target]);
    assert.equal(JSON.parse(status.stdout).completed_audits, 0);
  });

  it('persists a genuine signed Auditor return through the installed production verifier', () => {
    const target = makeFlowTarget('protected-packed-report-flow');
    const artifact = `commit:${git(target, 'rev-parse HEAD')}`;
    assert.equal(runPacked([
      'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o',
      '--evidence', 'npm test', '--target', target,
    ]).status, 0);
    const operatorTrustRoot = join(tmpBase, 'packed-auditor-operator');
    mkdirSync(operatorTrustRoot, { recursive: true });
    const trust = createTestHostTrust({ target });
    writeHostTrustStore(operatorTrustRoot, trust);
    const report = wireReport(artifact, ['T-001'], 'packed-protected-ref');
    report.invocation.receipt = null;
    const receipt = createAuditorReturnReceipt({
      receiptId: 'packed-protected-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: report.invocation.reference, invocationMode: report.invocation.mode,
      workUnit: 'milestone:M00', candidateArtifact: artifact, coveredTasks: report.covered_tasks,
      reportDigest: auditorReturnReportDigest(report),
      issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
    }, trust.privateKey);
    report.invocation.receipt = JSON.stringify(receipt);
    const reportFile = join(target, '.agenticloop', 'tmp', 'protected-run.json');
    writeFileSync(reportFile, JSON.stringify(report), 'utf8');
    const result = runPackedWithAuditorVerifier([
      'audit', 'report', 'AUD-001', '--file', reportFile, '--target', target,
    ], {
      target, operatorTrustRoot, adapterId: trust.adapterId, privateKey: trust.privateKey,
      keyId: trust.keyId,
      now: Date.parse('2026-08-08T12:00:00.000Z'),
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const status = runPacked(['audit', 'status', 'AUD-001', '--json', '--target', target]);
    assert.equal(JSON.parse(status.stdout).completed_audits, 1);
  });

  /**
   * The packaged reference host integration.
   *
   * `loadAuditorReturnReceiptVerifier()` is a seam; until now nothing in the
   * package occupied it, so "install/wire the production packed verifier" had
   * no shipped answer and every operator had to author the wrapper themselves.
   * These cases drive the shipped `agenticloop/protected-host-boundary` module
   * from a clean installed tarball: one genuine signed Auditor return persists,
   * and every way the protected channel can be absent or wrong fails closed.
   */
  describe('packaged protected-host reference integration', () => {
    function setup(name) {
      const target = makeFlowTarget(name);
      const artifact = `commit:${git(target, 'rev-parse HEAD')}`;
      assert.equal(runPacked([
        'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
        '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o',
        '--evidence', 'npm test', '--target', target,
      ]).status, 0);
      const operatorTrustRoot = join(tmpBase, `${name}-operator`);
      mkdirSync(operatorTrustRoot, { recursive: true });
      const trust = createTestHostTrust({ target });
      writeHostTrustStore(operatorTrustRoot, trust);
      const report = wireReport(artifact, ['T-001'], `${name}-ref`);
      report.invocation.receipt = null;
      const receiptNow = Date.now();
      const receipt = createAuditorReturnReceipt({
        receiptId: `${name}-receipt`, adapterId: trust.adapterId, keyId: trust.keyId,
        targetRepository: trust.repositoryIdentity,
        invocationReference: report.invocation.reference, invocationMode: report.invocation.mode,
        workUnit: 'milestone:M00', candidateArtifact: artifact, coveredTasks: report.covered_tasks,
        reportDigest: auditorReturnReportDigest(report),
        issuedAt: new Date(receiptNow - 60_000).toISOString(),
        expiresAt: new Date(receiptNow + 300_000).toISOString(),
      }, trust.privateKey);
      report.invocation.receipt = JSON.stringify(receipt);
      const reportFile = join(target, '.agenticloop', 'tmp', `${name}.json`);
      writeFileSync(reportFile, JSON.stringify(report), 'utf8');
      return {
        target, operatorTrustRoot, trust, reportFile,
        run: overrides => runPackedThroughPackagedBoundary([
          'audit', 'report', 'AUD-001', '--file', reportFile, '--target', target,
        ], {
          target, operatorTrustRoot, adapterId: trust.adapterId, keyId: trust.keyId,
          privateKey: trust.privateKey,
          ...overrides,
        }),
      };
    }

    it('persists one genuine signed Auditor return through the shipped integration', () => {
      const fx = setup('packaged-boundary-positive');
      const result = fx.run({});
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      const status = runPacked(['audit', 'status', 'AUD-001', '--json', '--target', fx.target]);
      assert.equal(JSON.parse(status.stdout).completed_audits, 1);

      // The key never appears in the child's own environment or arguments.
      assert.doesNotMatch(result.stdout + result.stderr, /BEGIN (?:EC |RSA )?PRIVATE KEY/);
    });

    it('refuses a byte-identical replay without mutating audit history or budget', () => {
      const fx = setup('packaged-boundary-replay');
      const first = fx.run({});
      assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
      const recordPath = join(fx.target, '.agenticloop', 'audits', 'AUD-001.md');
      const afterFirst = readFileSync(recordPath, 'utf8');
      const statusAfterFirst = runPacked(['audit', 'status', 'AUD-001', '--json', '--target', fx.target]).stdout;

      const replayed = fx.run({});
      assert.equal(replayed.status, 1, `${replayed.stdout}${replayed.stderr}`);
      const diagnostics = replayed.stderr
        .split('\n')
        .filter(line => line.startsWith('Cannot record audit report:'));
      assert.equal(diagnostics.filter(line => /invocation receipt '.*' was already used/.test(line)).length, 1);
      assert.equal(diagnostics.filter(line => /return receipt identity '.*' was already used/.test(line)).length, 0);

      // The durable record - history and budgets alike - is byte-identical.
      assert.equal(readFileSync(recordPath, 'utf8'), afterFirst);
      assert.equal(
        runPacked(['audit', 'status', 'AUD-001', '--json', '--target', fx.target]).stdout,
        statusAfterFirst
      );
    });

    it('fails closed when the protected channel is absent', () => {
      const fx = setup('packaged-boundary-absent');
      const result = fx.run({ withKey: false });
      assert.equal(result.status, 9, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /boundary unavailable/);
      assert.match(result.stderr, /no readable configuration on file descriptor 3/);
      const status = runPacked(['audit', 'status', 'AUD-001', '--json', '--target', fx.target]);
      assert.equal(JSON.parse(status.stdout).completed_audits, 0);
    });

    const MALFORMED_CHANNELS = [
      ['an empty descriptor', Buffer.alloc(0), /carried no configuration/],
      ['arbitrary bytes', Buffer.from('not json'), /not valid JSON/],
      ['an open schema', Buffer.from('{"kind":"agenticloop.protected-host-config","schemaVersion":1,"extra":true}'), /closed schema/],
    ];

    it('fails closed for every malformed protected channel', () => {
      const fx = setup('packaged-boundary-malformed');
      for (const [label, bytes, pattern] of MALFORMED_CHANNELS) {
        const result = fx.run({ withKey: 'variant', configBytes: bytes });
        assert.equal(result.status, 9, `${label}: ${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /boundary unavailable/, label);
        assert.match(result.stderr, pattern, label);
      }
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const wrongAlgorithm = fx.run({
        withKey: 'variant',
        configOverrides: { privateKey: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
      });
      assert.equal(wrongAlgorithm.status, 9, `${wrongAlgorithm.stdout}${wrongAlgorithm.stderr}`);
      assert.match(wrongAlgorithm.stderr, /must be an ed25519 private key/);
      const status = runPacked(['audit', 'status', 'AUD-001', '--json', '--target', fx.target]);
      assert.equal(JSON.parse(status.stdout).completed_audits, 0);
    });

    it('refuses a key the operator never pinned for the named adapter', () => {
      const fx = setup('packaged-boundary-stranger');
      const stranger = generateHostSigningKey();
      const result = fx.run({
        withKey: 'variant',
        configOverrides: { privateKey: stranger.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
      });
      assert.equal(result.status, 9, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /boundary unavailable/);
      const status = runPacked(['audit', 'status', 'AUD-001', '--json', '--target', fx.target]);
      assert.equal(JSON.parse(status.stdout).completed_audits, 0);
    });

    it('registers no agent-callable signing command', () => {
      const help = runPacked(['help']);
      assert.equal(help.status, 0, help.stderr);
      const surface = help.stdout + runPacked(['--help']).stdout;
      for (const forbidden of [/\bsign\b/i, /protected-host/i, /host-boundary/i]) {
        assert.doesNotMatch(surface, forbidden, 'the protected boundary must not be reachable as a CLI subcommand');
      }
      const attempted = runPacked(['protected-host-boundary']);
      assert.notEqual(attempted.status, 0);
    });

    it('does not export alternate descriptor, key-reader, or signing-callback seams', async () => {
      const boundaryModule = await import(pathToFileURL(join(packedRoot, 'src', 'protected-host-boundary.js')).href);
      assert.equal(typeof boundaryModule.loadProtectedAuditorReturnVerifier, 'function');
      assert.equal(boundaryModule.PROTECTED_KEY_DESCRIPTOR, 3);
      assert.equal(boundaryModule.readProtectedHostSigningKey, undefined);
      assert.equal(boundaryModule.createInheritedDescriptorHostBoundary, undefined);
    });

    it('refuses caller-selected security configuration and a cross-target protected envelope', async () => {
      const boundaryModule = await import(pathToFileURL(join(packedRoot, 'src', 'protected-host-boundary.js')).href);
      const injected = boundaryModule.loadProtectedAuditorReturnVerifier({
        target: join(tmpBase, 'caller-selected-target'),
        operatorTrustRoot: join(tmpBase, 'caller-selected-root'),
        readKey: () => generateHostSigningKey().privateKey,
      });
      assert.equal(injected.ok, false);
      assert.match(injected.errors.join('\n'), /accepts only the target option/);

      const fx = setup('packaged-boundary-cross-target');
      const result = fx.run({
        withKey: 'variant',
        configOverrides: { targetRepositoryIdentity: targetRepositoryIdentity(join(tmpBase, 'different-target')) },
      });
      assert.equal(result.status, 9, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /does not match the target repository/);
    });
  });

  it('refuses packed closeout when no verified Auditor report exists', () => {
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
    const report = runPacked(['audit', 'report', 'AUD-001', '--file', reportFile, '--target', target]);
    assert.equal(report.status, 1);
    assert.match(report.stderr, /requires a host receipt verifier/);

    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = runPacked([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--output', packetPath, '--target', target,
    ]);
    assert.equal(prepared.status, 1);
    assert.match(`${prepared.stdout}${prepared.stderr}`, /audit/i);
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

  /**
   * The dispatch-packet byte budget, measured on installed code.
   *
   * 16,384 bytes is a **regression benchmark for the canonical fixture**, not a
   * runtime protocol maximum. Nothing in the dispatch contract rejects a larger
   * packet, and nothing here adds such a rejection: the threshold exists so an
   * unnoticed growth in the canonical acting context fails a test rather than
   * quietly enlarging every role invocation. The source suite measures the same
   * budget against a packet built in-process; this measures the packet the
   * installed package actually emits.
   */
  const DISPATCH_PACKET_BUDGET_BYTES = 16_384;

  it('keeps a real installed current-schema packet inside the canonical byte budget', async () => {
    const envelope = await import(pathToFileURL(join(packedRoot, 'src', 'dispatch-envelope.js')).href);
    const canonical = await import(pathToFileURL(join(packedRoot, 'src', 'canonical-json.js')).href);
    // A stable, realistically sized target directory name, so the measurement
    // is comparable between runs rather than varying with a random suffix.
    const fixture = await createDispatchFixture(tmpBase, 'packed-packet-budget');
    // The installed package's own adapter configuration, so the bound
    // host-role capability declaration is the shipped one.
    writeFileSync(
      join(fixture.root, 'agenticloop.json'),
      readFileSync(join(packedRoot, 'config.json'), 'utf8'),
      'utf8'
    );
    writeFileSync(
      join(fixture.root, 'dispatch-input.json'),
      JSON.stringify({
        readiness: fixture.readiness,
        decomposition: fixture.decomposition,
        assignment: fixture.assignment,
      }),
      'utf8'
    );
    const prepared = runPackedWithBoundary([
      'task', 'prepare-dispatch', 'T-001',
      '--input', 'dispatch-input.json',
      '--host-trust-store', fixture.trustStorePath,
      '--json', '--target', fixture.root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      privateKey: fixture.trust.privateKey,
    });
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const packet = JSON.parse(prepared.stdout);

    // A real current packet from installed code, not a synthetic stand-in.
    assert.equal(packet.kind, 'agenticloop.role-preparation');
    assert.equal(packet.schemaVersion, envelope.DISPATCH_PREPARATION_SCHEMA_VERSION);
    assert.equal(packet.schemaVersion, 6);
    const validated = envelope.validateDispatchPreparation(packet, { capabilities: fixture.trust.capabilities });
    assert.equal(validated.ok, true, JSON.stringify(validated.findings ?? validated.errors ?? null));

    const packetBytes = Buffer.byteLength(canonical.canonicalJson(packet), 'utf8');
    assert.ok(
      packetBytes <= DISPATCH_PACKET_BUDGET_BYTES,
      `installed dispatch packet is ${packetBytes} bytes, above the ${DISPATCH_PACKET_BUDGET_BYTES}-byte regression benchmark`
    );
    assert.ok(packetBytes > 0);

    // The measured packet is available to the measurement smoke test below.
    packetBudget = {
      packet,
      packetBytes,
      path: join(fixture.root, 'measured-packet.json'),
      validationOptions: { capabilities: fixture.trust.capabilities },
    };
    writeFileSync(packetBudget.path, JSON.stringify(packet), 'utf8');
  });

  it('classifies an installed current-schema packet carrying canonical v3 degraded reports as typed stale', async () => {
    assert.ok(packetBudget, 'the real installed packet must be prepared first');
    const envelope = await import(pathToFileURL(join(packedRoot, 'src', 'dispatch-envelope.js')).href);
    const legacy = structuredClone(packetBudget.packet);
    const declaration = legacy.assignment.hostRoleCapability;
    legacy.assignment.degradedEnforcementReports = legacy.assignment.degradedEnforcementReports.map(report => ({
      ...report,
      schemaVersion: 3,
      limitation: declaration.limitation,
      detectionBoundary: declaration.detectionBoundary,
      recoveryRoute: declaration.recoveryRoute,
    }));
    legacy.digest = envelope.dispatchPreparationDigest(legacy);

    const checked = envelope.validateDispatchPreparation(legacy, packetBudget.validationOptions);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation degraded-enforcement report schemaVersion 3 is stale; regenerate the packet before dispatch or return import',
    }]);
  });

  it('ships and runs the installed acting-context measurement script', () => {
    const scriptPath = join(packedRoot, 'scripts', 'measure-dispatch-context.mjs');
    assert.ok(existsSync(scriptPath), 'packed package must ship scripts/measure-dispatch-context.mjs');
    assert.ok(packetBudget, 'the real installed packet must be measured first');
    // The measurement runs against the real corrected current-schema packet, not a
    // synthetic stand-in, so `canonical_packet` reports the bytes a role
    // invocation actually carries.
    const packetPath = packetBudget.path;
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
    // The measured canonical packet is the real one, and its component byte
    // count is the same number the budget regression above asserted.
    const packetComponent = result.components.find(component => component.kind === 'canonical_packet');
    assert.equal(packetComponent.bytes, packetBudget.packetBytes);
    assert.ok(
      packetComponent.bytes <= DISPATCH_PACKET_BUDGET_BYTES,
      `measured canonical packet is ${packetComponent.bytes} bytes`
    );
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
