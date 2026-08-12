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
import { targetRepositoryIdentity } from '../src/host-trust.js';
import { createTestHostTrust, writeHostTrustStore } from './helpers/host-trust-fixture.js';
import { runProcess } from './helpers/process-runner.js';

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

describe('packed package boundary', { concurrency: PACKED_CONCURRENCY }, () => {
  it('ships and imports every canonical handoff module', async () => {
    const recognition = await import(pathToFileURL(join(packedRoot, 'src', 'handoff-recognition.js')).href);
    const binding = await import(pathToFileURL(join(packedRoot, 'src', 'handoff-binding.js')).href);
    const consumption = await import(pathToFileURL(join(packedRoot, 'src', 'handoff-consumption.js')).href);
    assert.equal(typeof recognition.recognizeHandoff, 'function');
    assert.equal(typeof binding.recognizeRoleStart, 'function');
    assert.equal(typeof consumption.validateDispatchConsumption, 'function');
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
      'const boundary = await import("agenticloop/protected-host-boundary");',
      'const root = await import("agenticloop");',
      'assert.equal(typeof receipts.verifyAuditorReturnReceipt, "function");',
      'assert.equal(typeof receipts.AUDITOR_RECEIPT_MAX_VALIDITY_MS, "number");',
      'assert.equal(typeof schema.prepareAuditorReturnReportForSigning, "function");',
      'assert.equal(typeof trust.HOST_TRUST_CHALLENGE_TTL_MS, "number");',
      'assert.deepEqual([...grants.ACTIVATION_ASSURANCE_ORDER], ["operator_confirmed", "host_signed"]);',
      'assert.deepEqual(policy.MODE_MINIMUMS.hardened, { activation: "host_signed", return: "host_receipt" });',
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
