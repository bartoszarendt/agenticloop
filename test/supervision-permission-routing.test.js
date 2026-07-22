/**
 * Three-tier permission-routing coverage.
 *
 * Coverage is organized by boundary rather than by module: configuration
 * strictness, exact repository containment, structured command validation, the
 * bounded transient scope, the three-tier controller flow, atomic decision
 * validation, bounded decision memory, and the sanitized corpus measurement.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_SUPERVISION_CONFIG,
  PERMISSION_ROUTING_MODES,
  SUPERVISION_CONFIG_VERSION,
  normalizePermissionRouting,
  validateSupervisionConfig,
} from '../src/supervision/config.js';
import {
  CANONICAL_PERMISSION_OPERATIONS,
  RECOMMENDED_PERMISSION_POLICY,
  evaluatePathContainment,
  evaluatePermissionRouting,
  evaluateStructuredCommand,
  normalizePermissionOperation,
  parseStructuredCommand,
  validateBashRule,
} from '../src/supervision/permission-policy.js';
import {
  PermissionDecisionCache,
  TransientPermissionScopeStore,
  buildTransientPermissionScope,
  permissionCacheContext,
} from '../src/supervision/permission-memory.js';
import { SupervisionKernel, createInitialRuntimeState } from '../src/supervision/kernel.js';
import { SupervisionController } from '../src/supervision/controller.js';
import { normalizeOpencodePermissionRequest } from '../src/adapters/opencode-supervision-plugin.js';
import {
  CORPUS_PROJECT_DIRECTORIES,
  CORPUS_PROJECT_FILES,
  OPENCODE_PERMISSION_CORPUS,
} from './fixtures/opencode-permission-corpus.js';

const directories = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop(), { recursive: true, force: true });
});

const CLOCK = Date.UTC(2026, 6, 22);

function temporaryDirectory(prefix) {
  const created = mkdtempSync(join(tmpdir(), prefix));
  directories.push(created);
  return created;
}

/**
 * A fixture project with an ordinary source tree, protected areas, and -- when
 * the platform allows it without elevation -- a junction that leaves the tree.
 */
function fixtureProject({ junction = true } = {}) {
  const project = temporaryDirectory('al-perm-project-');
  const outside = temporaryDirectory('al-perm-outside-');
  writeFileSync(join(outside, 'notes.txt'), 'outside');
  for (const directory of CORPUS_PROJECT_DIRECTORIES) mkdirSync(join(project, ...directory.split('/')), { recursive: true });
  for (const file of CORPUS_PROJECT_FILES) {
    const full = join(project, ...file.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'fixture');
  }
  let junctionCreated = false;
  if (junction) {
    try {
      symlinkSync(outside, join(project, 'escape'), 'junction');
      junctionCreated = existsSync(join(project, 'escape'));
    } catch {
      junctionCreated = false;
    }
  }
  return { project, outside, outsideName: basename(outside), junctionCreated };
}

function routerConfig({ transient = 'redacted-provider', cache = false, policy = RECOMMENDED_PERMISSION_POLICY } = {}) {
  const value = structuredClone(DEFAULT_SUPERVISION_CONFIG);
  value.enabled = true;
  value.supervisor.model = 'provider/supervisor';
  value.permissions.mode = 'policy-assess-human';
  value.permissions.transient_scope = { mode: transient, maximum_age_seconds: 120, maximum_entries: 20 };
  value.permissions.policy = structuredClone(policy);
  value.permissions.decision_cache = {
    enabled: cache,
    maximum_entries: 4,
    policy_ttl_seconds: 900,
    supervisor_ttl_seconds: 300,
    rejection_ttl_seconds: 600,
  };
  return value;
}

function legacyConfig() {
  const value = structuredClone(DEFAULT_SUPERVISION_CONFIG);
  value.enabled = true;
  value.supervisor.model = 'provider/supervisor';
  return value;
}

function routingFor(project, request, overrides = {}) {
  return evaluatePermissionRouting({
    policy: { ...RECOMMENDED_PERMISSION_POLICY, protected_paths: [] },
    projectRoot: project,
    workingDirectory: project,
    transientScopeEnabled: true,
    ...request,
    ...overrides,
  });
}

describe('versioned permission configuration', () => {
  it('keeps version 1 behaviour by default and rejects unusable new-mode combinations', () => {
    assert.equal(SUPERVISION_CONFIG_VERSION, 2);
    assert.deepEqual([...PERMISSION_ROUTING_MODES], ['eligible-once-only', 'policy-assess-human']);

    const legacy = validateSupervisionConfig(legacyConfig());
    assert.deepEqual(legacy.errors, []);
    assert.equal(legacy.routing.mode, 'eligible-once-only');
    assert.equal(legacy.routing.router_active, false, 'an unmigrated document never reaches the new router');
    assert.equal(legacy.routing.transient_scope.enabled, false);
    assert.equal(legacy.routing.decision_cache.enabled, false);
    assert.deepEqual(legacy.routing.policy.auto_operations, []);

    const strict = validateSupervisionConfig(routerConfig({ cache: true }));
    assert.deepEqual(strict.errors, []);
    assert.equal(strict.routing.router_active, true);
    assert.equal(strict.routing.transient_scope.enabled, true);

    // Transient scope and decision memory are inert without the router, so
    // configuring them in legacy mode is an error, not a silent no-op.
    const strandedTransient = legacyConfig();
    strandedTransient.permissions.transient_scope = { mode: 'redacted-provider', maximum_age_seconds: 60, maximum_entries: 10 };
    assert.ok(validateSupervisionConfig(strandedTransient).errors.some(error => error.includes('transient_scope.mode requires')));

    const strandedCache = legacyConfig();
    strandedCache.permissions.decision_cache = { ...strandedCache.permissions.decision_cache, enabled: true };
    assert.ok(validateSupervisionConfig(strandedCache).errors.some(error => error.includes('decision_cache.enabled requires')));

    const strandedPolicy = legacyConfig();
    strandedPolicy.permissions.policy = { ...strandedPolicy.permissions.policy, auto_operations: ['read'] };
    assert.ok(validateSupervisionConfig(strandedPolicy).errors.some(error => error.includes('policy grants require')));
  });

  it('rejects unknown keys, unsafe rules, unbounded caches, and malformed path policy', () => {
    const unknownKey = routerConfig();
    unknownKey.permissions.transient_scope.retain_forever = true;
    assert.ok(validateSupervisionConfig(unknownKey).errors.some(error => error.includes('transient_scope.retain_forever is not supported')));

    const unsafe = routerConfig();
    unsafe.permissions.policy.auto_operations = ['bash', 'webfetch', 'frobnicate'];
    unsafe.permissions.policy.protected_paths = ['C:/absolute', '../escape', 'ok/*'];
    unsafe.permissions.policy.bash_rules = [
      'git status',
      { executable: 'npm', subcommand: 'test', allowed_flags: [], allow_paths: false },
      { executable: 'git', subcommand: 'log', allowed_flags: ['--output'], allow_paths: false },
      { executable: 'git', subcommand: 'log', allowed_flags: ['--oneline'], allow_paths: false, sudo: true },
    ];
    const errors = validateSupervisionConfig(unsafe).errors;
    assert.ok(errors.some(error => error.includes("auto_operations[0] 'bash' can never be mechanically proven low impact")));
    assert.ok(errors.some(error => error.includes("auto_operations[1] 'webfetch'")));
    assert.ok(errors.some(error => error.includes("auto_operations[2] 'frobnicate' is not a known permission operation")));
    assert.ok(errors.some(error => error.includes('protected_paths[0] must be project-relative')));
    assert.ok(errors.some(error => error.includes('protected_paths[1] must not traverse')));
    assert.ok(errors.some(error => error.includes('protected_paths[2] must be an exact path prefix')));
    assert.ok(errors.some(error => error.includes('bash_rules[0] must be a structured object')), 'a free-form prefix is not a structured rule');
    assert.ok(errors.some(error => error.includes("bash_rules[1].executable 'npm' runs project-controlled")));
    assert.ok(errors.some(error => error.includes("bash_rules[2].allowed_flags[0] '--output' can redirect output")));
    assert.ok(errors.some(error => error.includes('bash_rules[3].sudo is not supported')));

    const unbounded = validateSupervisionConfig({
      ...routerConfig({ cache: true }),
      permissions: { ...routerConfig({ cache: true }).permissions, decision_cache: { enabled: true, maximum_entries: 100_000, policy_ttl_seconds: 900, supervisor_ttl_seconds: 300, rejection_ttl_seconds: 0 } },
    }).errors;
    assert.ok(unbounded.some(error => error.includes('maximum_entries must be an integer between 1 and 1000')));
    assert.ok(unbounded.some(error => error.includes('rejection_ttl_seconds must be an integer between 1 and 86400')));

    const inverted = routerConfig({ cache: true });
    inverted.permissions.decision_cache.supervisor_ttl_seconds = 900;
    inverted.permissions.decision_cache.policy_ttl_seconds = 300;
    assert.ok(validateSupervisionConfig(inverted).errors.some(error => error.includes('must not exceed policy_ttl_seconds')));
  });

  it('normalizes deterministically and always keeps the built-in protected set', () => {
    const first = normalizePermissionRouting(routerConfig());
    const second = normalizePermissionRouting(routerConfig());
    assert.deepEqual(first, second);
    assert.ok(first.policy.protected_paths.includes('.git'));
    assert.ok(first.policy.protected_paths.includes('.agenticloop/state'));
    assert.ok(first.policy.protected_paths.includes('.github/workflows'));

    const custom = routerConfig();
    custom.permissions.policy.protected_paths = ['config/secrets'];
    const normalized = normalizePermissionRouting(custom);
    assert.ok(normalized.policy.protected_paths.includes('config/secrets'));
    assert.ok(normalized.policy.protected_paths.includes('.git'), 'a configured set extends the built-in one, never replaces it');
  });
});

describe('canonical permission operation identity', () => {
  it('keeps one identity for every configured operation and leaves unknown operations unknown', () => {
    for (const operation of CANONICAL_PERMISSION_OPERATIONS) {
      assert.equal(normalizePermissionOperation(operation), operation);
      assert.equal(normalizePermissionOperation(operation.toUpperCase()), operation);
    }
    // These four normalized to `unknown` in the previous public projection.
    for (const operation of ['grep', 'glob', 'list', 'search']) {
      assert.equal(normalizePermissionOperation(operation), operation);
    }
    assert.equal(normalizePermissionOperation('quantum_refactor'), 'unknown');
    assert.equal(normalizePermissionOperation(''), 'unknown');
    assert.equal(normalizePermissionOperation(undefined), 'unknown');
  });

  it('publishes the same identity through the kernel projection', () => {
    const { project } = fixtureProject({ junction: false });
    const { kernel } = routerKernel({ project });
    for (const operation of ['grep', 'glob', 'list', 'search']) {
      kernel.recordPermission({ id: `req-${operation}`, session_id: 'worker-lane-a', operation, patterns: ['src/**/*.js'] });
    }
    const pending = kernel.status().permissions.pending;
    assert.deepEqual(pending.map(entry => entry.operation).sort(), ['glob', 'grep', 'list', 'search']);
  });
});

describe('exact permission repository containment', () => {
  it('routes every containment case table-driven', () => {
    const { project, outsideName, junctionCreated } = fixtureProject();
    const absoluteInside = join(project, 'src', 'index.js');

    const cases = [
      ['ordinary project file', { operation: 'read', paths: ['src/index.js'] }, 'policy'],
      ['pinned read event pattern', { operation: 'read', patterns: ['src/index.js'] }, 'policy'],
      ['file named auth/session.js', { operation: 'read', paths: ['src/auth/session.js'] }, 'policy'],
      ['file named permissions/index.js', { operation: 'read', paths: ['src/permissions/index.js'] }, 'policy'],
      ['file named merge/strategy.js', { operation: 'edit', paths: ['src/merge/strategy.js'] }, 'policy'],
      ['file named delete-queue.js', { operation: 'edit', paths: ['src/delete-queue.js'] }, 'policy'],
      ['absolute path inside the project', { operation: 'read', paths: [absoluteInside] }, 'policy'],
      ['nonexistent write target', { operation: 'write', paths: ['src/new/deep/file.js'] }, 'policy'],
      ['windows separators', { operation: 'read', paths: ['src\\auth\\session.js'] }, 'policy'],
      ['case variation', { operation: 'read', paths: ['SRC/INDEX.JS'] }, process.platform === 'win32' ? 'policy' : 'human'],
      ['dot traversal', { operation: 'read', paths: [`../${outsideName}/notes.txt`] }, 'human'],
      ['another drive', { operation: 'read', paths: ['Z:/data/notes.txt'] }, 'human'],
      ['drive-relative path', { operation: 'read', paths: ['C:src/index.js'] }, 'human'],
      ['unc path', { operation: 'read', paths: ['//fileserver/share/notes.txt'] }, 'human'],
      ['protected vcs internals', { operation: 'read', paths: ['.git/config'] }, 'human'],
      ['protected dotenv', { operation: 'read', paths: ['.env.local'] }, 'human'],
      ['protected key material', { operation: 'read', paths: ['certs/server.pem'] }, 'human'],
      ['protected workflow', { operation: 'edit', paths: ['.github/workflows/ci.yml'] }, 'human'],
      ['missing path', { operation: 'read', paths: [] }, 'human'],
      ['multiple targets, one escapes', { operation: 'read', paths: ['src/index.js', `../${outsideName}/notes.txt`] }, 'human'],
      ['wildcard scope', { operation: 'grep', patterns: ['src/**/*.js'] }, 'assess'],
      ['wildcard traversal', { operation: 'grep', patterns: ['../**/*.js'] }, 'human'],
    ];
    if (junctionCreated) {
      cases.push(['existing junction escape', { operation: 'read', paths: ['escape/notes.txt'] }, 'human']);
      cases.push(['nonexistent child below a junction', { operation: 'write', paths: ['escape/created.txt'] }, 'human']);
    }

    for (const [label, request, expected] of cases) {
      assert.equal(routingFor(project, request).tier, expected, `${label} must route ${expected}`);
    }
  });

  it('proves containment for reads and searches, not only writes', () => {
    const { project, outsideName } = fixtureProject({ junction: false });
    for (const operation of ['read', 'grep', 'list', 'search', 'edit', 'write']) {
      const escaping = routingFor(project, { operation, paths: [`../${outsideName}/notes.txt`] });
      assert.equal(escaping.tier, 'human', `${operation} must not leave the project root`);
      assert.equal(escaping.containment.checked, true);
      assert.equal(escaping.containment.inside_project, false);
    }
  });

  it('refuses an unusable working directory rather than guessing one', () => {
    const { project, outside } = fixtureProject({ junction: false });
    const result = evaluatePathContainment('index.js', {
      projectRoot: project,
      workingDirectory: outside,
      protectedKeys: [],
      caseInsensitive: process.platform === 'win32',
    });
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'working_directory_outside_project');
  });
});

describe('structured permission command validation', () => {
  it('refuses everything outside the supported grammar', () => {
    const refusals = [
      ['git status && rm -rf build', 'shell_composition'],
      ['git status || true', 'shell_composition'],
      ['git status | head', 'shell_composition'],
      ['git status; ls', 'shell_composition'],
      ['git status\nrm -rf build', 'shell_composition'],
      ['git status `whoami`', 'shell_composition'],
      ['git show $(cat /tmp/ref)', 'shell_composition'],
      ['git show ${REF}', 'shell_composition'],
      ['git status > out.txt', 'shell_composition'],
      ['git status < in.txt', 'shell_composition'],
      ['git status & ', 'shell_composition'],
      ['git status "quoted arg"', 'quoting_not_supported'],
      ['GIT_DIR=/tmp git status', 'environment_mutation'],
      ['./scripts/git status', 'executable_path_not_supported'],
      ['git status --weird!flag', 'unrecognized_token'],
      ['', 'missing_command'],
    ];
    for (const [command, reason] of refusals) {
      const parsed = parseStructuredCommand(command);
      assert.equal(parsed.ok, false, `${command} must not parse`);
      assert.equal(parsed.reason, reason, `${command} must be refused as ${reason}`);
    }
    assert.deepEqual(parseStructuredCommand('git diff --stat src/index.js'), { ok: true, executable: 'git', argv: ['diff', '--stat', 'src/index.js'] });
  });

  it('rejects output flags, unknown flags, and deceptively similar prefixes', () => {
    const { project } = fixtureProject({ junction: false });
    const options = { projectRoot: project, workingDirectory: project, protectedKeys: ['.git'], caseInsensitive: process.platform === 'win32' };
    const rules = RECOMMENDED_PERMISSION_POLICY.bash_rules;

    assert.equal(evaluateStructuredCommand('git status --porcelain', rules, options).ok, true);
    assert.equal(evaluateStructuredCommand('git diff --stat src/index.js', rules, options).ok, true);

    assert.equal(evaluateStructuredCommand('git log --oneline --output=report.txt', rules, options).reason, 'output_flag');
    assert.equal(evaluateStructuredCommand('git log --oneline -o report.txt', rules, options).reason, 'output_flag');
    assert.equal(evaluateStructuredCommand('git status --ignored', rules, options).reason, 'flag_not_configured');
    assert.equal(evaluateStructuredCommand('git statuses', rules, options).reason, 'subcommand_not_configured');
    assert.equal(evaluateStructuredCommand('git status src/index.js', rules, options).reason, 'positional_arguments_not_allowed');
    assert.equal(evaluateStructuredCommand('git diff --stat .git/config', rules, options).reason, 'protected_path');
    assert.equal(evaluateStructuredCommand('npm test', rules, options).reason, 'executable_not_configured');
    assert.equal(evaluateStructuredCommand('npx agenticloop validate', rules, options).reason, 'executable_not_configured');
  });

  it('never accepts a rule that could execute project-controlled or downloaded code', () => {
    for (const executable of ['npm', 'npx', 'node', 'bash', 'powershell', 'curl', 'rm', 'docker']) {
      const errors = validateBashRule({ executable, subcommand: null, allowed_flags: [], allow_paths: false }, 'rule');
      assert.ok(errors.some(error => error.includes('can never be automatically approved')), `${executable} must be refused`);
    }
    assert.deepEqual(validateBashRule({ executable: 'git', subcommand: 'status', allowed_flags: ['--porcelain'], allow_paths: false }, 'rule'), []);
  });

  it('routes an unprovable command to assess and a proven boundary violation to the operator', () => {
    const { project, outsideName } = fixtureProject({ junction: false });
    assert.equal(routingFor(project, { operation: 'bash', command: 'npm test' }).tier, 'assess');
    assert.equal(routingFor(project, { operation: 'bash', command: 'npx agenticloop validate' }).tier, 'assess');
    assert.equal(routingFor(project, { operation: 'bash', command: 'git diff --stat .git/config' }).tier, 'human');
    assert.equal(routingFor(project, { operation: 'bash', command: `git diff --stat ../${outsideName}/notes.txt` }).tier, 'human');
    assert.equal(routingFor(project, { operation: 'bash', command: 'git status --porcelain' }).tier, 'policy');
  });
});

describe('bounded transient permission scope', () => {
  it('never stores credential-bearing scope and bounds entries, strings, and lifetime', () => {
    let clock = CLOCK;
    const store = new TransientPermissionScopeStore({ maximumEntries: 2, maximumAgeMs: 60_000, now: () => clock });

    assert.equal(buildTransientPermissionScope({ request_id: 'a', operation: 'bash', command: 'curl -H Authorization:Bearer_PLACEHOLDER0123456789 https://x.test' }), null);
    assert.equal(buildTransientPermissionScope({ request_id: 'a', operation: 'read', paths: ['https://user:PLACEHOLDER0123456789@example.test'] }), null);

    const long = buildTransientPermissionScope({ request_id: 'a', operation: 'bash', command: 'x'.repeat(5_000), paths: Array.from({ length: 200 }, (_, index) => `src/file-${index}.js`) });
    assert.equal(long.command.length, 300);
    assert.equal(long.paths.length, 20);

    store.insert('a', buildTransientPermissionScope({ request_id: 'a', operation: 'read' }));
    store.insert('b', buildTransientPermissionScope({ request_id: 'b', operation: 'read' }));
    assert.equal(store.insert('a', buildTransientPermissionScope({ request_id: 'a', operation: 'write', command: 'replaced' })), false, 'an immutable scope cannot be replaced');
    store.insert('c', buildTransientPermissionScope({ request_id: 'c', operation: 'read' }));
    assert.equal(store.size, 2);
    assert.equal(store.read('a'), null, 'capacity eviction removed the oldest entry');

    clock += 61_000;
    store.prune();
    assert.equal(store.size, 0, 'entries expire');
  });

  it('validates request identity, authorization generation, and session generation on read', () => {
    const store = new TransientPermissionScopeStore({ now: () => CLOCK });
    store.insert('req-1', buildTransientPermissionScope({ request_id: 'req-1', operation: 'read', authorization_generation: 1, session_generation: 2 }));
    assert.ok(store.read('req-1', { authorization_generation: 1, session_generation: 2 }));
    assert.equal(store.read('req-1', { authorization_generation: 2, session_generation: 2 }), null);
    assert.equal(store.read('req-1', { authorization_generation: 1, session_generation: 3 }), null);
    assert.equal(store.read('req-2', {}), null);
  });
});

/** A kernel wired to the new router against a real fixture project. */
function routerKernel({ project, config = null, laneId = 'lane-a', now = () => CLOCK } = {}) {
  const runtimeConfig = config ?? routerConfig();
  const state = createInitialRuntimeState({
    runId: 'sup-router-run',
    controllerId: 'controller-router',
    projectRoot: project,
    config: { ...runtimeConfig, opencode_version_range: '>=1.18.4 <1.19.0' },
    now,
  });
  const replies = [];
  const kernel = new SupervisionKernel({
    state,
    config: runtimeConfig,
    now,
    projectRoot: project,
    permissionScopeKey: 'router-test-key',
    host: { permissionReply: permission => { replies.push(permission); } },
  });
  kernel.registerRoot({ session_id: 'root-1', project_root: project });
  kernel.registerSupervisor('supervisor-1');
  kernel.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
  kernel.prepareLane({ lane_id: laneId, role: 'engineer', task_ref: 'T-1', expected_artifact: `commit:${laneId}`, authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2' });
  kernel.bindLaneSession(laneId, `worker-${laneId}`);
  return { kernel, replies, runtimeConfig };
}

describe('transient scope reaches only the assess tier', () => {
  it('stores an exact scope for assess and nothing for policy, human, or sensitive requests', () => {
    const { project } = fixtureProject({ junction: false });
    const { kernel } = routerKernel({ project });

    kernel.recordPermission({ id: 'req-policy', session_id: 'worker-lane-a', operation: 'read', metadata: { filePath: 'src/index.js' }, working_directory: project });
    kernel.recordPermission({ id: 'req-assess', session_id: 'worker-lane-a', operation: 'bash', metadata: { command: 'npm test' }, working_directory: project });
    kernel.recordPermission({ id: 'req-human', session_id: 'worker-lane-a', operation: 'read', metadata: { filePath: '.git/config' }, working_directory: project });
    kernel.recordPermission({ id: 'req-secret', session_id: 'worker-lane-a', operation: 'bash', metadata: { command: 'curl -H Authorization:Bearer_PLACEHOLDER0123456789 https://x.test' }, working_directory: project });

    assert.equal(kernel.transientPermissionScope('req-policy'), null);
    assert.equal(kernel.transientPermissionScope('req-human'), null);
    assert.equal(kernel.transientPermissionScope('req-secret'), null);

    const scope = kernel.transientPermissionScope('req-assess');
    assert.ok(scope, 'the assess tier receives the exact bounded scope');
    assert.equal(scope.command, 'npm test');
    assert.equal(scope.operation, 'bash');
    assert.equal(scope.lane_id, 'lane-a');
    assert.equal(scope.task_ref, 'T-1');
    assert.equal(scope.expected_artifact, 'commit:lane-a');
    assert.equal(scope.request_id, 'req-assess');
    assert.equal(scope.authorization_generation, 1);
    assert.equal(scope.scope_fingerprint, undefined, 'the internal cache fingerprint is never provider scope');
    // The transient view carries exactly one request. Unrelated pending
    // requests are never bundled into it.
    assert.equal(JSON.stringify(scope).includes('req-policy'), false);
    assert.equal(JSON.stringify(scope).includes('.git/config'), false);
  });

  it('keeps every transient and raw scope out of durable, public, and logged surfaces', () => {
    const { project } = fixtureProject({ junction: false });
    const { kernel } = routerKernel({ project });
    kernel.recordPermission({ id: 'req-assess', session_id: 'worker-lane-a', operation: 'bash', metadata: { command: 'npm run build:private-report' }, working_directory: project });
    const fingerprint = kernel.state.permissions[0].scope_fingerprint;

    for (const [label, payload] of [
      ['status', kernel.status()],
      ['model view', kernel.modelView()],
      ['human summary', kernel.humanSummary()],
      ['durable state', kernel.state],
      ['reattachment snapshot', kernel.reattachmentSnapshot()],
      ['diagnostics', kernel.state.diagnostics],
      ['events', kernel.state.events],
      ['notifications', kernel.state.notifications],
    ]) {
      assert.equal(JSON.stringify(payload).includes('private-report'), false, `${label} leaked the raw command`);
    }
    // The durable internal record keeps the run-keyed fingerprint deliberately;
    // no projection outside the kernel may republish it.
    for (const [label, payload] of [
      ['status', kernel.status()],
      ['model view', kernel.modelView()],
      ['human summary', kernel.humanSummary()],
      ['reattachment snapshot', kernel.reattachmentSnapshot()],
    ]) {
      assert.equal(JSON.stringify(payload).includes(fingerprint), false, `${label} exposed the scope fingerprint`);
    }
    const permission = kernel.status().permissions.pending[0];
    assert.equal(permission.metadata.command, '');
    assert.deepEqual(permission.patterns, []);
    assert.equal(permission.routing_tier, 'assess');
    assert.equal(permission.containment.checked, false);
  });

  it('drops transient scope on decision, authorization change, session replacement, and loss', () => {
    const { project } = fixtureProject({ junction: false });
    const record = (kernel, id = 'req-assess') => kernel.recordPermission({ id, session_id: 'worker-lane-a', operation: 'bash', metadata: { command: 'npm test' }, working_directory: project });

    const authorization = routerKernel({ project });
    record(authorization.kernel);
    authorization.kernel.authorizeWorkUnit({ unit_id: 'U-2', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
    assert.equal(authorization.kernel.transientPermissionScope('req-assess'), null);

    const rebound = routerKernel({ project });
    record(rebound.kernel);
    rebound.kernel.bindLaneSession('lane-a', 'worker-lane-a-2');
    assert.equal(rebound.kernel.transientPermissionScope('req-assess'), null);

    const bridge = routerKernel({ project });
    record(bridge.kernel);
    bridge.kernel.markBridgeLost('test');
    assert.equal(bridge.kernel.transientPermissionScopes.size, 0);

    const server = routerKernel({ project });
    record(server.kernel);
    server.kernel.markServerLost('test');
    assert.equal(server.kernel.transientPermissionScopes.size, 0);

    const paused = routerKernel({ project });
    record(paused.kernel);
    paused.kernel.pause();
    assert.equal(paused.kernel.transientPermissionScopes.size, 0);

    const stopped = routerKernel({ project });
    record(stopped.kernel);
    stopped.kernel.stop();
    assert.equal(stopped.kernel.transientPermissionScopes.size, 0);

    const decided = routerKernel({ project });
    record(decided.kernel);
    decided.kernel.decidePermission('req-assess', 'once', { principal: 'operator' });
    assert.equal(decided.kernel.transientPermissionScope('req-assess'), null);
  });
});

/** A controller wired to the new router against a real fixture project. */
function routerController(project, runtimeConfig, { replyFails = false } = {}) {
  const controller = new SupervisionController({
    projectRoot: project,
    config: runtimeConfig,
    runId: 'sup-router-controller',
    credential: 'r'.repeat(48),
    now: () => CLOCK,
    setTicker: () => ({ unref() { return this; } }),
    clearTicker: () => {},
  });
  const calls = { hostReplies: [], supervisor: [], wakes: [] };
  controller.hostCall = async (method, params) => {
    if (method === 'host.permission.reply') {
      if (replyFails) throw new Error('host reply failed');
      calls.hostReplies.push(params.permission);
      return { ok: true };
    }
    if (method === 'host.supervisor.assess') {
      calls.supervisor.push(params);
      return { disposition: { action: 'request_operator', target: params.action_context.target, rationale: 'operator review' } };
    }
    return { ok: true };
  };
  controller.kernel.registerRoot({ session_id: 'root-1', project_root: project });
  controller.kernel.registerSupervisor('supervisor-1');
  controller.kernel.markBridgeConnected({ capabilities: {} });
  controller.kernel.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
  controller.kernel.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:lane-a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2' });
  controller.kernel.bindLaneSession('lane-a', 'worker-lane-a');
  controller.kernel.markLaneStarted('lane-a', 'worker-lane-a');
  return { controller, calls };
}

function ask(controller, id, permission, project) {
  return controller.handleRequest('permission.asked', { permission: { id, session_id: 'worker-lane-a', working_directory: project, ...permission } });
}

describe('three-tier controller flow and budget semantics', () => {
  it('answers policy requests without a model and charges no budget', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());

    const result = await ask(controller, 'req-policy', { operation: 'read', metadata: { filePath: 'src/index.js' } }, project);
    await controller.wakeChain;

    assert.equal(result.permission.routing_tier, 'policy');
    assert.equal(result.permission.status, 'approved_once');
    assert.equal(result.permission.decided_by, 'policy');
    assert.equal(result.permission.policy_version, RECOMMENDED_PERMISSION_POLICY.version);
    assert.equal(calls.hostReplies.length, 1);
    assert.equal(calls.hostReplies[0].status, 'approved_once');
    assert.equal(calls.supervisor.length, 0, 'the policy tier never wakes the model');
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 0);
    assert.equal(controller.kernel.state.budgets.used.supervisor_wakeups, 0);
  });

  it('leaves human-tier requests pending without a model call or budget charge', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());

    for (const [id, permission] of [
      ['req-protected', { operation: 'read', metadata: { filePath: '.git/config' } }],
      ['req-unknown', { operation: 'quantum_refactor', metadata: { filePath: 'src/index.js' } }],
      ['req-incomplete', { operation: 'read', metadata: {} }],
      ['req-release', { operation: 'bash', metadata: { command: 'git push origin main' } }],
      ['req-secret', { operation: 'bash', metadata: { command: 'curl -H Authorization:Bearer_PLACEHOLDER0123456789 https://x.test' } }],
    ]) {
      const result = await ask(controller, id, permission, project);
      assert.equal(result.routing_tier, 'human', `${id} must route to the operator`);
      assert.equal(result.assessment_scheduled, false);
      assert.equal(result.permission.status, 'pending');
    }
    await controller.wakeChain;
    assert.equal(calls.supervisor.length, 0);
    assert.equal(calls.hostReplies.length, 0);
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 0);
    assert.equal(controller.kernel.state.budgets.used.supervisor_wakeups, 0);
  });

  it('charges an assessment and a wakeup only when an assessment actually begins', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());

    const scheduled = await ask(controller, 'req-assess', { operation: 'bash', metadata: { command: 'npm test' } }, project);
    await controller.wakeChain;
    assert.equal(scheduled.routing_tier, 'assess');
    assert.equal(scheduled.assessment_scheduled, true);
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 1);
    assert.equal(controller.kernel.state.budgets.used.supervisor_wakeups, 1);
    assert.equal(calls.supervisor.length, 1);

    // The scope travels in its own request-bound field, never in the question.
    const payload = calls.supervisor[0];
    assert.equal(payload.permission_scope.request_id, 'req-assess');
    assert.equal(payload.permission_scope.command, 'npm test');
    assert.equal(payload.permission_scope.scope_fingerprint, undefined);
    assert.equal(payload.action_context.request_id, 'req-assess');
    assert.equal(payload.question.includes('npm test'), false, 'raw scope is never interpolated into the question');
    assert.equal(JSON.stringify(payload.state).includes('npm test'), false, 'the durable model view stays redacted');
    assert.deepEqual(payload.allowed_actions, ['approve_permission_once', 'reject_permission', 'request_operator']);
  });

  it('charges no assessment or wakeup when a queued request is paused before the provider boundary', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());
    let releaseQueue;
    controller.wakeChain = new Promise(resolve => { releaseQueue = resolve; });

    const scheduled = await ask(controller, 'req-paused-queue', { operation: 'bash', metadata: { command: 'npm test' } }, project);
    assert.equal(scheduled.assessment_scheduled, true);
    controller.kernel.pause();
    releaseQueue();
    await controller.wakeChain;

    assert.equal(calls.supervisor.length, 0);
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 0);
    assert.equal(controller.kernel.state.budgets.used.supervisor_wakeups, 0);
  });

  it('routes pinned OpenCode read and write-tool permission shapes end to end', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());
    const read = normalizeOpencodePermissionRequest({
      id: 'host-read', sessionID: 'worker-lane-a', type: 'read',
      pattern: ['src/index.js'], metadata: {},
    }, project);
    const writeTool = normalizeOpencodePermissionRequest({
      id: 'host-write-tool', sessionID: 'worker-lane-a', type: 'edit',
      pattern: ['src/new-module.js'], metadata: { filepath: 'src/new-module.js', diff: 'sanitized fixture diff' },
    }, project);

    const readResult = await controller.handleRequest('permission.asked', { permission: read });
    const writeResult = await controller.handleRequest('permission.asked', { permission: writeTool });
    await controller.wakeChain;

    assert.equal(readResult.permission.routing_tier, 'policy');
    assert.equal(writeResult.permission.routing_tier, 'policy');
    assert.equal(calls.hostReplies.length, 2);
    assert.equal(calls.supervisor.length, 0);
  });

  it('never offers approve_permission_once for a human-tier request', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());
    await ask(controller, 'req-protected', { operation: 'read', metadata: { filePath: '.git/config' } }, project);
    await controller.wakeChain;
    assert.equal(calls.supervisor.length, 0);
    assert.throws(
      () => controller.kernel.previewPermissionDecision('req-protected', 'once', { principal: 'supervisor' }),
      /supervisor may not answer/
    );
  });

  it('routes assess candidates to the operator when transient scope is disabled', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig({ transient: 'disabled' }));
    const result = await ask(controller, 'req-assess', { operation: 'bash', metadata: { command: 'npm test' } }, project);
    await controller.wakeChain;
    assert.equal(result.routing_tier, 'human');
    assert.equal(calls.supervisor.length, 0);
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 0);
  });

  it('returns duplicates without consuming budgets or scheduling another action', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());
    const permission = { operation: 'bash', metadata: { command: 'npm test' } };
    await ask(controller, 'req-assess', permission, project);
    const duplicate = await ask(controller, 'req-assess', permission, project);
    await controller.wakeChain;
    assert.equal(duplicate.duplicate, true);
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 1);
    assert.equal(calls.supervisor.length, 1);
  });

  it('leaves a policy request pending when the host reply fails', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller } = routerController(project, routerConfig(), { replyFails: true });
    const result = await ask(controller, 'req-policy', { operation: 'read', metadata: { filePath: 'src/index.js' } }, project);
    assert.equal(result.code, 'host_reply_failed');
    assert.equal(controller.kernel.state.permissions.find(entry => entry.id === 'req-policy').status, 'pending');
    assert.ok(controller.kernel.state.notifications.some(entry => entry.summary.includes('could not be delivered')));
  });

  it('routes to the operator when authorization is missing, without a model call', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());
    controller.kernel.state.authorization = null;
    const result = await ask(controller, 'req-policy', { operation: 'read', metadata: { filePath: 'src/index.js' } }, project);
    await controller.wakeChain;
    assert.equal(result.routing_tier, 'human');
    assert.equal(calls.supervisor.length, 0);
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 0);
  });

  it('leaves an assess request pending when the supervisor is unreachable', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());
    controller.kernel.state.bridge.status = 'lost';
    const result = await ask(controller, 'req-assess', { operation: 'bash', metadata: { command: 'npm test' } }, project);
    await controller.wakeChain;
    assert.equal(result.assessment_scheduled, false);
    assert.equal(result.code, 'supervisor_model_unavailable');
    assert.equal(calls.supervisor.length, 0);
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 0);
    assert.equal(controller.kernel.state.permissions.find(entry => entry.id === 'req-assess').status, 'pending');
  });

  it('escalates to the operator when the transient scope has gone before the provider call', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig());
    const original = controller.kernel.transientPermissionScope.bind(controller.kernel);
    let reads = 0;
    controller.kernel.transientPermissionScope = requestId => {
      reads += 1;
      return reads === 1 ? original(requestId) : null;
    };
    await ask(controller, 'req-assess', { operation: 'bash', metadata: { command: 'npm test' } }, project);
    await controller.wakeChain;
    assert.equal(calls.supervisor.length, 0, 'a stale scope never reaches the provider');
    assert.ok(controller.kernel.state.notifications.some(entry => entry.summary.includes('Permission scope was unavailable')));
  });
});

describe('atomic permission decision validation across principals', () => {
  it('binds each internal principal to its exact authority', () => {
    const { project } = fixtureProject({ junction: false });
    const { kernel } = routerKernel({ project });
    kernel.recordPermission({ id: 'req-policy', session_id: 'worker-lane-a', operation: 'read', metadata: { filePath: 'src/index.js' }, working_directory: project });
    kernel.recordPermission({ id: 'req-assess', session_id: 'worker-lane-a', operation: 'bash', metadata: { command: 'npm test' }, working_directory: project });
    kernel.recordPermission({ id: 'req-human', session_id: 'worker-lane-a', operation: 'read', metadata: { filePath: '.git/config' }, working_directory: project });

    assert.throws(() => kernel.previewPermissionDecision('req-policy', 'reject', { principal: 'policy' }), /may only approve a request once/);
    assert.throws(() => kernel.previewPermissionDecision('req-policy', 'always', { principal: 'policy' }), /may only approve a request once/);
    assert.throws(() => kernel.previewPermissionDecision('req-assess', 'once', { principal: 'policy' }), /policy may not answer/);
    assert.throws(() => kernel.previewPermissionDecision('req-human', 'once', { principal: 'policy' }), /policy may not answer/);
    assert.throws(() => kernel.previewPermissionDecision('req-human', 'once', { principal: 'supervisor' }), /supervisor may not answer/);
    assert.throws(() => kernel.previewPermissionDecision('req-assess', 'always', { principal: 'supervisor' }), /always permission approval is human-only/);
    assert.throws(() => kernel.previewPermissionDecision('req-assess', 'once', { principal: 'attacker' }), /verified policy, supervisor, cache, or operator provenance/);
    assert.throws(() => kernel.previewPermissionDecision('req-assess', 'once', { principal: 'cache' }), /requires its complete cache context/);
    assert.throws(() => kernel.previewPermissionDecision('req-human', 'always', { principal: 'cache' }), /never become an OpenCode always grant/);

    assert.equal(kernel.previewPermissionDecision('req-policy', 'once', { principal: 'policy' }).status, 'approved_once');
    assert.equal(kernel.previewPermissionDecision('req-assess', 'once', { principal: 'supervisor' }).status, 'approved_once');
    assert.equal(kernel.previewPermissionDecision('req-human', 'always', { principal: 'operator' }).status, 'approved_always');
  });

  it('refuses a policy decision made against a different policy version', () => {
    const { project } = fixtureProject({ junction: false });
    const { kernel } = routerKernel({ project });
    kernel.recordPermission({ id: 'req-policy', session_id: 'worker-lane-a', operation: 'read', metadata: { filePath: 'src/index.js' }, working_directory: project });
    kernel.permissionRouting.policy.version = 99;
    assert.throws(() => kernel.previewPermissionDecision('req-policy', 'once', { principal: 'policy' }), /does not match the active policy version/);
  });

  it('prohibits supervisor self-approval for every principal', () => {
    const { project } = fixtureProject({ junction: false });
    const { kernel } = routerKernel({ project });
    kernel.recordPermission({ id: 'req-self', session_id: 'supervisor-1', operation: 'read', metadata: { filePath: 'src/index.js' }, working_directory: project });
    const permission = kernel.state.permissions.find(entry => entry.id === 'req-self');
    assert.equal(permission.routing_tier, 'human');
    assert.deepEqual(permission.risk_categories, ['supervisor_self_request']);
    assert.throws(() => kernel.previewPermissionDecision('req-self', 'once', { principal: 'supervisor' }), /supervisor may not answer/);
    assert.throws(() => kernel.previewPermissionDecision('req-self', 'once', { principal: 'policy' }), /policy may not answer/);
  });

  it('records bounded audit fields without a raw scope or a reusable fingerprint', async () => {
    const { project } = fixtureProject({ junction: false });
    const { kernel } = routerKernel({ project });
    kernel.recordPermission({ id: 'req-policy', session_id: 'worker-lane-a', operation: 'read', metadata: { filePath: 'src/index.js' }, working_directory: project });
    const decided = await kernel.replyPermission('req-policy', 'once', { principal: 'policy' });
    assert.equal(decided.decided_by, 'policy');
    assert.equal(decided.policy_version, RECOMMENDED_PERMISSION_POLICY.version);
    assert.equal(decided.cache_origin_decision_id, null);
    const published = kernel.status().permissions.decided[0];
    assert.equal(published.decided_by, 'policy');
    assert.equal(published.scope_fingerprint, undefined, 'the fingerprint is never published');
    assert.equal(JSON.stringify(kernel.status()).includes('src/index.js'), false);
  });
});

describe('bounded fingerprint-scoped permission decision memory', () => {
  function cacheContext(overrides = {}) {
    return permissionCacheContext({
      project_identity: 'C:/project',
      authorization_generation: 1,
      lane_id: 'lane-a',
      session_id: 'worker-lane-a',
      session_generation: 1,
      task_ref: 'T-1',
      operation: 'read',
      policy_version: 1,
      scope_fingerprint: 'f'.repeat(64),
      ...overrides,
    });
  }

  it('hits only within one exact context and expires by principal-specific TTL', () => {
    let clock = CLOCK;
    const cache = new PermissionDecisionCache({ enabled: true, maximumEntries: 8, policyTtlMs: 900_000, supervisorTtlMs: 300_000, rejectionTtlMs: 600_000, now: () => clock });
    cache.set(cacheContext(), { decision: 'once', principal: 'policy', origin_decision_id: 'req-1' });
    assert.equal(cache.get(cacheContext()).decision, 'once');

    for (const boundary of [
      { project_identity: 'C:/other' },
      { authorization_generation: 2 },
      { lane_id: 'lane-b' },
      { session_generation: 2 },
      { task_ref: 'T-2' },
      { operation: 'write' },
      { policy_version: 2 },
      { scope_fingerprint: 'a'.repeat(64) },
      { progress_epoch: 1 },
    ]) {
      assert.equal(cache.get(cacheContext(boundary)), null, `${Object.keys(boundary)[0]} must not replay`);
    }

    cache.set(cacheContext({ operation: 'grep' }), { decision: 'once', principal: 'supervisor', origin_decision_id: 'req-2' });
    cache.set(cacheContext({ operation: 'glob' }), { decision: 'reject', principal: 'supervisor', origin_decision_id: 'req-3' });
    clock += 301_000;
    assert.equal(cache.get(cacheContext({ operation: 'grep' })), null, 'a supervisor approval expires first');
    assert.equal(cache.get(cacheContext({ operation: 'glob' })).decision, 'reject', 'a rejection has its own bounded lifetime');
    assert.equal(cache.get(cacheContext()).decision, 'once', 'a policy decision lives for the current generation');
    clock += 300_000;
    assert.equal(cache.get(cacheContext({ operation: 'glob' })), null, 'rejections cannot create an unbounded denial loop');
  });

  it('evicts deterministically by least-recent use and never stores an always grant', () => {
    const cache = new PermissionDecisionCache({ enabled: true, maximumEntries: 2, now: () => CLOCK });
    cache.set(cacheContext({ operation: 'read' }), { decision: 'once', principal: 'policy', origin_decision_id: 'a' });
    cache.set(cacheContext({ operation: 'write' }), { decision: 'once', principal: 'policy', origin_decision_id: 'b' });
    cache.get(cacheContext({ operation: 'read' }));
    cache.set(cacheContext({ operation: 'list' }), { decision: 'once', principal: 'policy', origin_decision_id: 'c' });
    assert.ok(cache.get(cacheContext({ operation: 'read' })), 'the recently used entry survives');
    assert.equal(cache.get(cacheContext({ operation: 'write' })), null, 'the least recently used entry was evicted');

    assert.equal(cache.set(cacheContext(), { decision: 'always', principal: 'operator', origin_decision_id: 'x' }), null);
    assert.equal(cache.stats().enabled, true);
    assert.ok(Number.isInteger(cache.stats().entries));
  });

  it('replays through the exact host reply path and records the originating decision', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig({ cache: true }));
    const scope = { operation: 'read', metadata: { filePath: 'src/index.js' } };

    const first = await ask(controller, 'req-1', scope, project);
    const second = await ask(controller, 'req-2', scope, project);
    await controller.wakeChain;

    assert.equal(first.permission.decided_by, 'policy');
    assert.equal(second.permission.decided_by, 'cache');
    assert.equal(second.permission.status, 'approved_once');
    assert.equal(second.permission.cache_origin_decision_id, 'req-1');
    assert.equal(second.permission.cache_key_version, 1);
    assert.equal(calls.hostReplies.length, 2, 'a replay still sends a host once response for the new request');
    assert.equal(calls.hostReplies[1].id, 'req-2');
    assert.equal(calls.supervisor.length, 0);
    assert.equal(controller.kernel.state.permission_routing.cache_hits, 1);

    const routing = controller.kernel.status().permission_routing;
    assert.equal(routing.cache.hits, 1);
    assert.ok(routing.cache.misses >= 1);
    assert.equal(routing.mode, 'policy-assess-human');
    assert.equal(JSON.stringify(routing).includes('src/index.js'), false);
  });

  it('does not replay across authorization changes, lanes, or a stopped controller', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller, calls } = routerController(project, routerConfig({ cache: true }));
    const scope = { operation: 'read', metadata: { filePath: 'src/index.js' } };
    await ask(controller, 'req-1', scope, project);
    controller.kernel.authorizeWorkUnit({ unit_id: 'U-2', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
    const afterAuthorization = await ask(controller, 'req-2', scope, project);
    assert.equal(afterAuthorization.permission.decided_by, 'policy', 'a new authorization generation invalidates the memory');
    assert.equal(calls.hostReplies.length, 2);

    controller.kernel.stop();
    assert.equal(controller.kernel.permissionDecisionCache.size, 0);
  });

  it('leaves a replayed request pending when the host reply fails', async () => {
    const { project } = fixtureProject({ junction: false });
    const { controller } = routerController(project, routerConfig({ cache: true }));
    const scope = { operation: 'read', metadata: { filePath: 'src/index.js' } };
    await ask(controller, 'req-1', scope, project);
    controller.hostCall = async method => {
      if (method === 'host.permission.reply') throw new Error('host reply failed');
      return { ok: true };
    };
    const replayed = await ask(controller, 'req-2', scope, project);
    assert.equal(replayed.code, 'host_reply_failed');
    assert.equal(controller.kernel.state.permissions.find(entry => entry.id === 'req-2').status, 'pending');
  });
});

describe('sanitized permission corpus', () => {
  it('routes every reviewed fixture shape as expected and reports the measured proportions', () => {
    const { project, outsideName, junctionCreated } = fixtureProject();
    const { kernel } = routerKernel({ project });
    const counts = { policy: 0, assess: 0, human: 0 };
    const mismatches = [];

    for (const entry of OPENCODE_PERMISSION_CORPUS) {
      if (entry.requires_junction && !junctionCreated) continue;
      const metadata = structuredClone(entry.event.metadata);
      // The corpus expresses its escape cases relative to the fixture pair.
      const rewrite = value => String(value).replace('../outside/', `../${outsideName}/`);
      for (const key of ['filePath', 'path', 'paths']) {
        if (metadata[key] === undefined) continue;
        metadata[key] = Array.isArray(metadata[key]) ? metadata[key].map(rewrite) : rewrite(metadata[key]);
      }
      const patterns = structuredClone(entry.event.pattern).map(rewrite);
      const permission = kernel.recordPermission({
        id: entry.id,
        session_id: entry.from_supervisor ? 'supervisor-1' : 'worker-lane-a',
        operation: entry.event.type,
        patterns,
        metadata,
        working_directory: project,
      });
      counts[permission.routing_tier] += 1;
      if (permission.routing_tier !== entry.expected_tier) mismatches.push(`${entry.id} (${entry.label}): expected ${entry.expected_tier}, got ${permission.routing_tier}`);
      if (entry.expects_sensitive) {
        assert.equal(permission.metadata.sensitive_material_redacted, true, `${entry.id} must be marked sensitive`);
        assert.equal(kernel.transientPermissionScope(entry.id), null, `${entry.id} must never be model-projected`);
      }
    }

    assert.deepEqual(mismatches, [], 'corpus routing must match the reviewed baseline');

    const total = counts.policy + counts.assess + counts.human;
    const percent = value => Math.round((value / total) * 1000) / 10;
    // Reported as a measurement over this corpus under the recommended policy.
    // It is not a claim about real traffic and not an acceptance threshold.
    process.stdout.write(
      `\n  corpus routing (measured, n=${total}): policy ${counts.policy} (${percent(counts.policy)}%), `
      + `assess ${counts.assess} (${percent(counts.assess)}%), human ${counts.human} (${percent(counts.human)}%)\n`
    );
    assert.equal(total, OPENCODE_PERMISSION_CORPUS.filter(entry => !entry.requires_junction || junctionCreated).length);
    assert.ok(counts.policy > 0 && counts.assess > 0 && counts.human > 0, 'the corpus must exercise all three tiers');
  });

  it('keeps every corpus fixture free of credentials and personal paths', () => {
    for (const entry of OPENCODE_PERMISSION_CORPUS) {
      assert.ok(['synthetic', 'sanitized-host-shape'].includes(entry.provenance), `${entry.id} must declare its provenance`);
      const serialized = JSON.stringify(entry);
      assert.equal(/C:\\Users|\/home\/|\/Users\//.test(serialized), false, `${entry.id} must not contain a personal path`);
      assert.equal(/sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{8,}\./.test(serialized), false, `${entry.id} must not contain a real token shape`);
    }
  });
});
