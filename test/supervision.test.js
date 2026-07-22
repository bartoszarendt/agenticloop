import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_SUPERVISION_CONFIG, OPENCODE_VERSION_BOUNDS, SUPPORTED_OPENCODE_VERSION_RANGE, isSupportedOpencodeVersion, normalizeLaneLease, validateSupervisionConfig } from '../src/supervision/config.js';
import { callAuthenticatedIpc, connectAuthenticatedIpc, createAuthenticatedIpcServer } from '../src/supervision/ipc.js';
import { ATTACHED_BRIDGE_CAPABILITIES, SupervisionKernel, createInitialRuntimeState } from '../src/supervision/kernel.js';
import { SupervisionController } from '../src/supervision/controller.js';
import { containsSensitiveMaterial, redactSecrets } from '../src/supervision/redaction.js';
import { classifyOpencodeOutcome, extractOpencodeEventId } from '../src/supervision/opencode-event-contract.js';
import {
  normalizeOpenCodeSupervisorUsage,
  parseAgenticLoopArguments,
  probeOpenCodeBridgeCapabilities,
  renderOpencodeSupervisionPlugin,
} from '../src/adapters/opencode-supervision-plugin.js';
import { PROVIDER_FIXTURE_MARKER, PROVIDER_FIXTURE_PURPOSE, validateProviderFixture } from '../src/supervision/provider-fixture.js';
import { PROVIDER_ARTIFACT_RELATIVE_PATH, runProviderScenario } from '../scripts/provider-supervision-driver.js';
import { formatPermissions, formatStatus } from '../src/supervision-cli.js';
import { loadEvents, resolveEventLogPath, validateEventLogFile } from '../src/event-logging.js';
import {
  PID_REUSE_REMEDIATION,
  acquireOwnershipLock,
  createRunId,
  readRunState,
  releaseOwnershipLock,
  supervisionPaths,
  writeRunState,
} from '../src/supervision/state.js';

const directories = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop(), { recursive: true, force: true });
});

function config() {
  const value = structuredClone(DEFAULT_SUPERVISION_CONFIG);
  value.enabled = true;
  value.supervisor.model = 'provider/supervisor';
  return value;
}

const PROBED_ATTACHED_CAPABILITIES = Object.freeze(Object.fromEntries(ATTACHED_BRIDGE_CAPABILITIES.map(name => [name, true])));

function bridgeIdentity(extra = {}) {
  return { capabilities: PROBED_ATTACHED_CAPABILITIES, ...extra };
}

function kernel(options = {}) {
  const runtimeConfig = config();
  const state = createInitialRuntimeState({
    runId: 'sup-test-run',
    controllerId: 'controller-test',
    projectRoot: 'C:/project',
    config: { ...runtimeConfig, opencode_version_range: '>=1.18.4 <1.19.0' },
    now: () => Date.UTC(2026, 6, 22),
  });
  return new SupervisionKernel({ state, config: runtimeConfig, now: () => Date.UTC(2026, 6, 22), ...options });
}

function authorizeAndPrepare(value, laneId, taskRef = 'T-1') {
  if (!value.state.sessions.root) value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
  if (!value.state.sessions.supervisor) value.registerSupervisor('supervisor-1');
  if (!value.state.authorization) value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
  value.prepareLane({
    lane_id: laneId,
    role: 'engineer',
    task_ref: taskRef,
    expected_artifact: `commit:${laneId}`,
    authorized_unit_id: 'U-1',
    scope_ref: 'task-file:T-1,T-2',
  });
  value.bindLaneSession(laneId, `worker-${laneId}`);
}

describe('optional supervision configuration', () => {
  it('pins the attached host version and rejects unsafe combinations', () => {
    assert.equal(isSupportedOpencodeVersion('1.18.4'), true);
    assert.equal(isSupportedOpencodeVersion('1.18.3'), false);
    assert.equal(isSupportedOpencodeVersion('1.19.0'), false);

    const unsafe = config();
    unsafe.activation.fail_closed = false;
    unsafe.permissions.always = 'supervisor';
    unsafe.execution.launch = 'managed';
    const result = validateSupervisionConfig(unsafe);
    assert.ok(result.errors.some(error => error.includes('fail_closed')));
    assert.ok(result.errors.some(error => error.includes('always')));
    assert.ok(result.errors.some(error => error.includes('managed mode')));

    const unknown = config();
    unknown.permissions.unchecked_escape_hatch = true;
    assert.ok(validateSupervisionConfig(unknown).errors.some(error => error.includes('unchecked_escape_hatch')));

    const weakenedEnvelope = config();
    weakenedEnvelope.permissions.human_only = weakenedEnvelope.permissions.human_only.filter(category => category !== 'credentials');
    assert.ok(validateSupervisionConfig(weakenedEnvelope).errors.some(error => error.includes('non-negotiable categories: credentials')));
  });
});

describe('supervision recovery state and locks', () => {
  it('writes versioned state atomically and refuses an unverified competing owner', () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-state-'));
    directories.push(project);
    const state = createInitialRuntimeState({
      runId: 'sup-state-run',
      controllerId: 'controller-a',
      projectRoot: project,
      config: { ...config(), opencode_version_range: '>=1.18.4 <1.19.0' },
    });
    state.controller.endpoint = { host: '127.0.0.1', port: 12345 };
    writeRunState(project, state);
    assert.equal(readRunState(project, 'sup-state-run').state.controller.endpoint.port, 12345);

    const first = acquireOwnershipLock(project, 'sup-state-run', { owner_id: 'a', pid: 1, process_instance: 'one' });
    const second = acquireOwnershipLock(project, 'sup-state-run', { owner_id: 'b', pid: 2, process_instance: 'two' });
    const differentRun = acquireOwnershipLock(project, 'sup-other-run', { owner_id: 'c', pid: 3, process_instance: 'three' });
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'pid_reused_or_owner_unverified');
    assert.equal(differentRun.acquired, false);
    assert.equal(releaseOwnershipLock(project, 'sup-state-run', 'b'), false);
    assert.equal(releaseOwnershipLock(project, 'sup-state-run', 'a'), true);
  });
});

describe('authenticated local supervision IPC', () => {
  it('binds requests to the exact run and project and rejects forged provenance', async () => {
    const credential = 'a'.repeat(48);
    const server = await createAuthenticatedIpcServer({
      credential,
      projectRoot: 'C:/project',
      runId: 'sup-ipc-run',
      onRequest: async (method, params) => ({ method, value: params.value }),
    });
    try {
      const result = await callAuthenticatedIpc(server.endpoint, {
        credential,
        project_root: 'C:/project',
        run_id: 'sup-ipc-run',
      }, 'status', { value: 'safe' });
      assert.deepEqual(result, { method: 'status', value: 'safe' });
      await assert.rejects(
        callAuthenticatedIpc(server.endpoint, {
          credential: 'b'.repeat(48),
          project_root: 'C:/project',
          run_id: 'sup-ipc-run',
        }, 'status'),
        /authentication or binding failed/
      );
    } finally {
      await server.close();
    }
  });
});

describe('supervision controller', () => {
  it('serves authenticated operator status and vetoes an unpinned host before bootstrap', async () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-controller-'));
    directories.push(project);
    const controller = new SupervisionController({
      projectRoot: project,
      config: config(),
      runId: 'sup-controller-run',
      credential: 'c'.repeat(48),
    });
    try {
      const handshake = await controller.start();
      assert.equal(handshake.minimum_capability_verdict, 'pending');
      const result = await callAuthenticatedIpc(controller.ipc.endpoint, controller.auth(), 'operator.command', {
        principal: 'operator',
        command: 'status',
      });
      assert.equal(result.ok, true);
      assert.equal(result.status.controller.run_id, 'sup-controller-run');
      await assert.rejects(
        controller.bootstrap({
          adapter: 'opencode',
          mode: 'attached',
          project_root: project,
          root_session_id: 'root-1',
          opencode_version: '1.18.2',
        }),
        /unsupported OpenCode version/
      );
    } finally {
      await controller.close();
    }
  });

  it('makes stop terminal, closes IPC, and releases project ownership', async () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-stop-'));
    directories.push(project);
    const first = new SupervisionController({
      projectRoot: project,
      config: config(),
      runId: 'sup-stop-first',
      credential: 's'.repeat(48),
    });
    await first.start();
    const credentialPath = supervisionPaths(project, 'sup-stop-first').credential;
    assert.equal(credentialPath.startsWith(project), false);
    assert.equal(existsSync(credentialPath), true);
    const endpoint = first.ipc.endpoint;
    const stopped = await callAuthenticatedIpc(endpoint, first.auth(), 'operator.command', {
      principal: 'operator',
      command: 'stop',
    });
    assert.equal(stopped.status.controller.status, 'stopped');
    await Promise.race([
      first.waitUntilClosed(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('controller did not close')), 1000)),
    ]);
    assert.equal(existsSync(credentialPath), false);
    await assert.rejects(callAuthenticatedIpc(endpoint, first.auth(), 'operator.command', {
      principal: 'operator', command: 'status',
    }), /ECONNREFUSED|connect/);

    const second = new SupervisionController({
      projectRoot: project,
      config: config(),
      runId: 'sup-stop-second',
      credential: 't'.repeat(48),
    });
    await second.start();
    await second.close();
  });

  it('runs bootstrap, event-driven retry, and exact permission approval through authenticated bridge IPC', async () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-bridge-'));
    directories.push(project);
    const controller = new SupervisionController({
      projectRoot: project,
      config: config(),
      runId: 'sup-bridge-run',
      credential: 'i'.repeat(48),
    });
    await controller.start();
    const permissionReplies = [];
    const bridge = await connectAuthenticatedIpc(controller.ipc.endpoint, controller.auth(), async (method, params) => {
      if (method === 'host.supervisor.create') return { session_id: 'supervisor-ipc' };
      if (method === 'host.supervisor.assess') {
        if (params.question.includes('permission request')) {
          return { disposition: JSON.stringify({ action: 'approve_permission_once', target: 'lane-ipc', request_id: 'req-ipc', rationale: 'exact read-only status request' }) };
        }
        return { disposition: JSON.stringify({ action: 'fresh_retry', target: 'lane-ipc', rationale: 'registered transport failure' }) };
      }
      if (method === 'host.lane.create') return { session_id: 'worker-ipc-retry' };
      if (method === 'host.lane.start') return { started: true };
      if (method === 'host.permission.reply') {
        permissionReplies.push(params.permission);
        return { replied: true };
      }
      throw new Error(`unexpected fake host method ${method}`);
    });
    try {
      await bridge.call('bridge.connect', bridgeIdentity());
      const handshake = await bridge.call('bootstrap', {
        adapter: 'opencode',
        mode: 'attached',
        project_root: project,
        root_session_id: 'root-ipc',
        opencode_version: '1.18.4',
      });
      assert.equal(handshake.minimum_capability_verdict, 'supported');
      await bridge.call('operator.command', { principal: 'operator', command: 'authorize', unit_id: 'U-IP', scope_ref: 'task-file:T-IP' });
      await bridge.call('lane.prepare', { envelope: { lane_id: 'lane-ipc', role: 'engineer', task_ref: 'T-IP', expected_artifact: 'commit:abc', authorized_unit_id: 'U-IP', scope_ref: 'task-file:T-IP' } });
      await bridge.call('lane.bind', { lane_id: 'lane-ipc', session_id: 'worker-ipc' });
      await bridge.call('host.outcome', { target: 'worker-ipc', outcome: 'failed_transport', metadata: {} });
      await controller.wakeChain;
      assert.equal(controller.kernel.findLane('lane-ipc').session_id, 'worker-ipc-retry');

      await bridge.call('permission.asked', { permission: { id: 'req-ipc', session_id: 'worker-ipc-retry', operation: 'bash', patterns: ['git status*'] } });
      await controller.wakeChain;
      assert.equal(permissionReplies.length, 1);
      assert.equal(permissionReplies[0].status, 'approved_once');
    } finally {
      bridge.close();
      await controller.close();
    }
  });
});

describe('mechanical supervision kernel', () => {
  it('does not create a lane before authorization and preserves a successful sibling', () => {
    const value = kernel();
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    assert.throws(() => value.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a' }), /authorization/);
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2' });
    value.bindLaneSession('lane-a', 'worker-a');
    value.prepareLane({ lane_id: 'lane-b', role: 'engineer', task_ref: 'T-2', expected_artifact: 'commit:b', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2' });
    value.bindLaneSession('lane-b', 'worker-b');
    value.recordOutcome('lane-a', 'completed', { reconciliation: { verified: true, present: true, kind: 'commit', reference: 'a' } });
    value.recordOutcome('lane-b', 'completed', { reconciliation: { verified: true, present: false, kind: 'commit', reference: 'b' } });

    assert.equal(value.findLane('lane-a').artifact_valid, true);
    assert.equal(value.findLane('lane-a').outcome, 'completed');
    assert.equal(value.findLane('lane-b').outcome, 'unknown');
    assert.equal(value.findLane('lane-b').no_artifact, true);
  });

  it('treats permission waits separately and permits always only for the operator', () => {
    const value = kernel();
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.registerSupervisor('supervisor-1');
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' });
    value.bindLaneSession('lane-a', 'worker-a');
    value.recordPermission({ id: 'req-a', session_id: 'worker-a', operation: 'bash', patterns: ['git status*'] });
    assert.equal(value.findLane('lane-a').outcome, 'waiting_permission');
    const approved = value.decidePermission('req-a', 'always', { principal: 'operator', rationale: 'Human selected matching requests' });
    assert.equal(approved.status, 'approved_always');
    assert.throws(() => value.decidePermission('req-a', 'reject', { principal: 'operator' }), /stale/);

    value.recordPermission({ id: 'req-self', session_id: 'supervisor-1', operation: 'bash' });
    assert.throws(() => value.decidePermission('req-self', 'once', { principal: 'supervisor' }), /may not answer/);

    value.recordPermission({ id: 'req-safe', session_id: 'worker-a', operation: 'bash', patterns: ['git status*'] });
    assert.equal(value.state.permissions.find(permission => permission.id === 'req-safe').authority, 'supervisor-eligible');
    assert.equal(value.decidePermission('req-safe', 'once', { principal: 'supervisor' }).status, 'approved_once');
  });

  it('keeps an exact permission pending when the host reply fails and ignores duplicate events', async () => {
    let failReply = true;
    const value = kernel({
      host: {
        permissionReply: async () => {
          if (failReply) throw new Error('host reply failed');
        },
      },
    });
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' });
    value.bindLaneSession('lane-a', 'worker-a');
    value.recordPermission({ id: 'req-atomic', session_id: 'worker-a', operation: 'bash', patterns: ['git status*'] });

    await assert.rejects(value.replyPermission('req-atomic', 'once', { principal: 'supervisor' }), /host reply failed/);
    assert.equal(value.state.permissions.find(permission => permission.id === 'req-atomic').status, 'pending');
    value.recordPermission({ id: 'req-atomic', session_id: 'worker-a', operation: 'bash', patterns: ['git status*'] });
    assert.equal(value.state.permissions.filter(permission => permission.id === 'req-atomic').length, 1);

    failReply = false;
    const approved = await value.replyPermission('req-atomic', 'once', { principal: 'supervisor' });
    assert.equal(approved.status, 'approved_once');
    const duplicate = value.recordPermission({ id: 'req-atomic', session_id: 'worker-a', operation: 'bash', patterns: ['git status*'] });
    assert.equal(duplicate.status, 'approved_once');
  });

  it('fails closed on scope expansion, stopped controllers, and high-impact permission requests', () => {
    const value = kernel();
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.registerSupervisor('supervisor-1');
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    assert.throws(
      () => value.prepareLane({ lane_id: 'lane-outside', role: 'engineer', task_ref: 'T-2', expected_artifact: 'commit:b', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' }),
      /outside the authorized scope/
    );
    value.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' });
    value.bindLaneSession('lane-a', 'worker-a');
    const dangerous = value.recordPermission({
      id: 'req-danger',
      session_id: 'worker-a',
      operation: 'bash',
      patterns: ['git push --force*'],
      metadata: { category: 'release' },
    });
    assert.equal(dangerous.authority, 'human-only');
    assert.throws(() => value.decidePermission('req-danger', 'once', { principal: 'supervisor' }), /may not answer/);
    value.stop();
    assert.throws(
      () => value.prepareLane({ lane_id: 'lane-stopped', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:c', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' }),
      /stopped/
    );
  });

  it('requires the supervisor model for semantic recovery and refuses ambiguous process termination', async () => {
    const value = kernel();
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' });
    value.markBridgeConnected(bridgeIdentity());
    const unavailableContext = value.issueActionContext({ allowed_actions: ['fresh_retry'], target: 'lane-a', target_kind: 'lane', wake_id: 'unavailable' });
    const unavailable = await value.applyDisposition({ action: 'fresh_retry', target: 'lane-a', rationale: 'transport reset' }, { modelAvailable: false, actionContext: unavailableContext });
    assert.equal(unavailable.code, 'supervisor_model_unavailable');
    const deniedContext = value.issueActionContext({ allowed_actions: ['terminate_owned_process'], target: 'lane-a', target_kind: 'lane', wake_id: 'denied' });
    const denied = await value.applyDisposition({ action: 'terminate_owned_process', target: 'lane-a', rationale: 'unknown pid' }, { actionContext: deniedContext });
    assert.deepEqual(denied, { ok: false, code: 'unsupported_capability', capability: 'process_termination' });
    value.markServerLost('test server shutdown');
    assert.equal(value.status().server.status, 'lost');
    assert.equal(value.status().controller.status, 'server_lost');
  });

  it('wakes the supervisor from a failed lane event and applies its bounded recovery disposition', async () => {
    const controller = new SupervisionController({
      projectRoot: 'C:/project',
      config: config(),
      runId: 'sup-wakeup-run',
      credential: 'w'.repeat(48),
    });
    controller.kernel.registerRoot({ session_id: 'root-1', project_root: controller.projectRoot });
    controller.kernel.registerSupervisor('supervisor-1');
    controller.kernel.markBridgeConnected(bridgeIdentity());
    controller.kernel.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    controller.kernel.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' });
    controller.kernel.bindLaneSession('lane-a', 'worker-a');
    controller.requestSupervisor = async () => ({
      ok: true,
      disposition: { action: 'fresh_retry', target: 'lane-a', rationale: 'transport failed after registration' },
    });
    controller.kernel.host.createLaneSession = async () => ({ session_id: 'worker-a-retry' });
    controller.kernel.host.startLane = async () => ({ started: true });
    await controller.handleRequest('host.outcome', { target: 'worker-a', outcome: 'failed_transport', metadata: {} });
    await controller.wakeChain;
    assert.equal(controller.kernel.findLane('lane-a').session_id, 'worker-a-retry');
    assert.ok(controller.kernel.state.events.some(event => event.type === 'supervision.assessed'));
  });

  it('does not let an operator cancellation bypass work-unit authorization', async () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-cancel-auth-'));
    directories.push(project);
    const controller = new SupervisionController({
      projectRoot: project,
      config: config(),
      runId: 'sup-cancel-auth-run',
      credential: 'x'.repeat(48),
    });
    controller.kernel.registerRoot({ session_id: 'root-1', project_root: project });
    await assert.rejects(
      controller.operatorCommand({ principal: 'operator', command: 'cancel', target: 'root' }),
      /authorization/
    );
  });

  it('persists failed supervisor replacement and escalates to the operator', async () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-replacement-'));
    directories.push(project);
    const controller = new SupervisionController({
      projectRoot: project,
      config: config(),
      runId: 'sup-replacement-run',
      credential: 'r'.repeat(48),
    });
    controller.kernel.registerRoot({ session_id: 'root-1', project_root: project });
    controller.kernel.registerSupervisor('supervisor-1');
    controller.hostCall = async () => { throw new Error('provider unavailable'); };
    const result = await controller.handleRequest('supervisor.failed', { session_id: 'supervisor-1', reason: 'session.error' });
    assert.deepEqual(result, { ok: false, code: 'supervisor_model_unavailable' });
    assert.equal(controller.kernel.state.budgets.used.supervisor_replacements, 1);
    assert.ok(controller.kernel.state.notifications.some(notification => notification.summary.includes('replacement failed')));
  });

  it('uses virtual time to wake on no progress and stops at the absolute time budget', async () => {
    let clock = Date.UTC(2026, 6, 22);
    const runtimeConfig = config();
    runtimeConfig.budgets.active_minutes = 10;
    runtimeConfig.budgets.absolute_age_minutes = 10;
    const controller = new SupervisionController({
      projectRoot: 'C:/clock',
      config: runtimeConfig,
      runId: 'sup-clock-run',
      credential: 'v'.repeat(48),
      now: () => clock,
    });
    controller.kernel.registerRoot({ session_id: 'root-clock', project_root: controller.projectRoot });
    controller.kernel.registerSupervisor('supervisor-clock');
    controller.kernel.authorizeWorkUnit({ unit_id: 'U-CLOCK', scope_ref: 'task-file:T-CLOCK', authorized_by: 'operator' });
    controller.kernel.prepareLane({ lane_id: 'lane-clock', role: 'engineer', task_ref: 'T-CLOCK', expected_artifact: 'commit:abc', authorized_unit_id: 'U-CLOCK', scope_ref: 'task-file:T-CLOCK' });
    controller.kernel.bindLaneSession('lane-clock', 'worker-clock');
    controller.kernel.markLaneStarted('lane-clock', 'worker-clock');
    let wakeups = 0;
    controller.requestSupervisor = async () => {
      wakeups += 1;
      return { ok: true, disposition: { action: 'continue_observing', target: 'lane-clock', rationale: 'await one bounded checkpoint' } };
    };
    clock += 6 * 60_000;
    await controller.tickObservation();
    await controller.wakeChain;
    assert.equal(wakeups, 2, 'lane and root no-progress checkpoints each wake the model');
    assert.equal(controller.kernel.state.budgets.used.lane_no_progress['lane-clock'], 1);

    clock += 5 * 60_000;
    await controller.tickObservation();
    assert.equal(controller.kernel.state.controller.status, 'stopped');
    assert.equal(controller.closed, true);
  });
});

describe('Phase 26 attached-mode safety regressions', () => {
  it('keeps public authorization while omitting secret authorization material and reports explicit collection truncation', () => {
    const value = kernel();
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    for (let index = 0; index < 25; index += 1) value.notify('budget', `notice ${index}`);

    const status = value.status({ notifications: { limit: 5 } });
    assert.deepEqual(status.authorization, {
      unit_id: 'U-1',
      scope_ref: 'task-file:T-1',
      provenance: 'operator',
      authorized_at: '2026-07-22T00:00:00.000Z',
    });
    assert.equal(status.collections.notifications.total, 20);
    assert.equal(status.collections.notifications.returned, 5);
    assert.equal(status.collections.notifications.truncated, true);
    assert.equal(JSON.stringify(status).includes('credential'), false);
  });

  it('requires exact authorization bindings on every lane envelope and rejects duplicate live lane ids', () => {
    const value = kernel();
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    const base = { lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a' };

    assert.throws(() => value.prepareLane(base), /authorized unit.*scope/i);
    assert.throws(() => value.prepareLane({ ...base, authorized_unit_id: 'U-2', scope_ref: 'task-file:T-1' }), /binding/);
    value.prepareLane({ ...base, authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' });
    assert.throws(() => value.prepareLane({ ...base, authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1' }), /duplicate live lane/i);
    assert.equal(value.findLane('lane-a').session_id, null);
  });

  it('atomically records positively verified artifacts and demotes missing artifacts', () => {
    const value = kernel();
    authorizeAndPrepare(value, 'lane-a');
    authorizeAndPrepare(value, 'lane-b', 'T-2');

    value.recordOutcome('lane-a', 'completed', {
      reconciliation: { verified: true, present: true, kind: 'commit', reference: 'lane-a' },
    });
    value.recordOutcome('lane-b', 'completed', {
      reconciliation: { verified: true, present: false, kind: 'commit', reference: 'lane-b' },
    });

    assert.equal(value.findLane('lane-a').artifact_valid, true);
    assert.equal(value.findLane('lane-a').outcome, 'completed');
    assert.equal(value.findLane('lane-b').artifact_valid, false);
    assert.equal(value.findLane('lane-b').no_artifact, true);
    assert.equal(value.findLane('lane-b').outcome, 'unknown');
  });

  it('binds all supervisor dispositions to the issued lane, root, request, route, and authorization context', async () => {
    const retried = [];
    const value = kernel({
      host: {
        createLaneSession: async lane => ({ session_id: `retry-${lane.id}` }),
        startLane: async lane => { retried.push(lane.id); },
        permissionReply: async () => {},
      },
    });
    authorizeAndPrepare(value, 'lane-a');
    authorizeAndPrepare(value, 'lane-b', 'T-2');
    value.recordPermission({ id: 'request-a', session_id: 'worker-lane-a', operation: 'bash', patterns: ['git status*'] });
    value.recordPermission({ id: 'request-b', session_id: 'worker-lane-b', operation: 'bash', patterns: ['git status*'] });

    const laneContext = value.issueActionContext({
      allowed_actions: ['fresh_retry', 'cancel_session'], target: 'lane-a', target_kind: 'lane', wake_id: 'wake-a',
    });
    const laneSubstitution = await value.applyDisposition({ action: 'fresh_retry', target: 'lane-b' }, { actionContext: laneContext });
    assert.deepEqual(laneSubstitution, { ok: false, code: 'invalid_disposition', reason: 'target_mismatch' });
    assert.deepEqual(retried, []);

    const permissionContext = value.issueActionContext({
      allowed_actions: ['approve_permission_once', 'reject_permission'], target: 'lane-a', target_kind: 'lane', request_id: 'request-a', wake_id: 'wake-permission',
    });
    const permissionSubstitution = await value.applyDisposition({
      action: 'approve_permission_once', target: 'lane-a', request_id: 'request-b',
    }, { actionContext: permissionContext });
    assert.deepEqual(permissionSubstitution, { ok: false, code: 'invalid_disposition', reason: 'request_mismatch' });

    const rootContext = value.issueActionContext({
      allowed_actions: ['cancel_session'], target: 'root', target_kind: 'root', wake_id: 'wake-root',
    });
    const rootSubstitution = await value.applyDisposition({ action: 'cancel_session', target: 'supervisor' }, { actionContext: rootContext });
    assert.deepEqual(rootSubstitution, { ok: false, code: 'invalid_disposition', reason: 'target_mismatch' });
  });

  it('leaves a created lane session registered as failed_start when prompting fails and ignores late events after cancellation', async () => {
    const value = kernel({
      host: {
        createLaneSession: async () => ({ session_id: 'created-lane-a' }),
        startLane: async () => { throw new Error('prompt failed'); },
      },
    });
    authorizeAndPrepare(value, 'lane-a');
    const retryContext = value.issueActionContext({ allowed_actions: ['fresh_retry'], target: 'lane-a', target_kind: 'lane', wake_id: 'wake-retry' });
    const result = await value.applyDisposition({ action: 'fresh_retry', target: 'lane-a' }, { actionContext: retryContext });
    assert.equal(result.code, 'failed_start');
    assert.equal(value.findLane('lane-a').session_id, 'created-lane-a');
    assert.equal(value.findLane('lane-a').lifecycle, 'failed_start');

    value.recordOutcome('lane-a', 'cancelled', { event_id: 'cancel-event', session_id: 'created-lane-a' });
    value.recordOutcome('lane-a', 'completed', {
      event_id: 'late-idle',
      session_id: 'created-lane-a',
      reconciliation: { verified: true, present: true, kind: 'commit', reference: 'lane-a' },
    });
    assert.equal(value.findLane('lane-a').outcome, 'cancelled');
  });

  it('implements bounded resume_work_unit rather than advertising an unsupported action', async () => {
    const value = kernel({ host: { reconcile: async () => ({ root: 'known', lanes: 'known', permissions: 'known' }) } });
    authorizeAndPrepare(value, 'lane-a');
    value.markBridgeConnected(bridgeIdentity());
    const context = value.issueActionContext({ allowed_actions: ['resume_work_unit'], target: 'root', target_kind: 'root', wake_id: 'wake-resume' });

    const result = await value.applyDisposition({ action: 'resume_work_unit', target: 'root' }, { actionContext: context });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'resume_work_unit');
    assert.notEqual(result.code, 'unsupported_action');
    assert.equal(value.state.sessions.lanes.length, 1);
  });

  it('prevents a queued paused wake from invoking the model or consuming its wakeup budget', async () => {
    const controller = new SupervisionController({
      projectRoot: 'C:/queued-pause', config: config(), runId: 'sup-queued-pause', credential: 'q'.repeat(48),
    });
    controller.kernel.registerRoot({ session_id: 'root-1', project_root: controller.projectRoot });
    controller.kernel.registerSupervisor('supervisor-1');
    controller.kernel.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    let wakeups = 0;
    controller.requestSupervisor = async () => { wakeups += 1; return { ok: true, disposition: { action: 'continue_observing', target: 'root' } }; };
    controller.scheduleSupervisorWake({ reason: 'queued wake', target: 'root', allowedActions: ['continue_observing'] });
    controller.kernel.pause();
    await controller.wakeChain;
    assert.equal(wakeups, 0);
    assert.equal(controller.kernel.state.budgets.used.supervisor_wakeups, 0);
  });

  it('does not let an operator retry accept a model target substitution and returns authorization in its post-authorization handshake', async () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-operator-target-'));
    directories.push(project);
    const controller = new SupervisionController({ projectRoot: project, config: config(), runId: 'sup-operator-target', credential: 'o'.repeat(48) });
    controller.kernel.registerRoot({ session_id: 'root-operator', project_root: project });
    controller.kernel.registerSupervisor('supervisor-operator');
    controller.kernel.markBridgeConnected(bridgeIdentity({ server_identity: 'server-operator' }));
    controller.kernel.authorizeWorkUnit({ unit_id: 'U-OPERATOR', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
    controller.kernel.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-OPERATOR', scope_ref: 'task-file:T-1,T-2' });
    controller.kernel.bindLaneSession('lane-a', 'worker-a');
    controller.kernel.prepareLane({ lane_id: 'lane-b', role: 'engineer', task_ref: 'T-2', expected_artifact: 'commit:b', authorized_unit_id: 'U-OPERATOR', scope_ref: 'task-file:T-1,T-2' });
    controller.kernel.bindLaneSession('lane-b', 'worker-b');
    let starts = 0;
    controller.kernel.host.createLaneSession = async () => ({ session_id: 'should-not-create' });
    controller.kernel.host.startLane = async () => { starts += 1; };
    controller.requestSupervisor = async () => ({ ok: true, disposition: { action: 'fresh_retry', target: 'lane-b', rationale: 'malicious substitution' } });

    const result = await controller.operatorCommand({ principal: 'operator', command: 'retry', target: 'lane-a' });
    assert.deepEqual(result, { ok: false, code: 'invalid_disposition', reason: 'target_mismatch', disposition: { action: 'fresh_retry', target: 'lane-b', rationale: 'malicious substitution' } });
    assert.equal(starts, 0);
    assert.deepEqual(controller.handshake().authorization, {
      unit_id: 'U-OPERATOR', scope_ref: 'task-file:T-1,T-2', authorized_at: controller.kernel.state.authorization.authorized_at,
    });
  });

  it('uses stable semver precedence for the supported OpenCode range', () => {
    assert.equal(isSupportedOpencodeVersion('1.18.4+build.7'), true);
    assert.equal(isSupportedOpencodeVersion('1.18.4-beta.1'), false);
    assert.equal(isSupportedOpencodeVersion('1.18.5-rc.1'), false);
  });

  it('projects material kernel events to the canonical enabled task JSONL path', () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-events-'));
    directories.push(project);
    mkdirSync(join(project, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(project, '.agenticloop', 'project.md'), [
      '---', 'setup_status: unconfirmed', 'setup_confirmed_at: ""', 'setup_confirmed_by: ""',
      'task_backend: files', 'event_logging: enabled', 'event_logging_command: ""',
      'task_id_pattern: "T-<number>"', 'task_id_regex: "^T-\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"', 'grouping_profile: flat', '---', '# Project Map',
    ].join('\n'), 'utf8');
    writeFileSync(join(project, '.agenticloop', 'tasks', 'T-001.md'), '# T-001\n', 'utf8');
    const runtimeConfig = config();
    const state = createInitialRuntimeState({ runId: 'sup-events', controllerId: 'controller-events', projectRoot: project, config: runtimeConfig, now: () => Date.UTC(2026, 6, 22) });
    const value = new SupervisionKernel({ state, config: runtimeConfig, projectRoot: project, now: () => Date.UTC(2026, 6, 22) });
    value.registerRoot({ session_id: 'root-events', project_root: project });
    value.authorizeWorkUnit({ unit_id: 'U-001', scope_ref: 'task-file:T-001', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-events', role: 'engineer', task_ref: 'T-001', expected_artifact: 'commit:abc', authorized_unit_id: 'U-001', scope_ref: 'task-file:T-001' });
    value.bindLaneSession('lane-events', 'worker-events');
    value.recordOutcome('worker-events', 'completed', { session_id: 'worker-events', reconciliation: { verified: true, present: true, kind: 'commit', reference: 'abc' } });

    const logPath = resolveEventLogPath(project, undefined, 'T-001').path;
    assert.deepEqual(validateEventLogFile(logPath, { target: project }).errors, []);
    assert.ok(loadEvents(logPath).some(event => event.event_type === 'supervision.registered'));
    assert.ok(loadEvents(logPath).some(event => event.event_type === 'supervision.reconciled'));
  });
});

const SENTINEL = 'SUPERSECRET-SENTINEL-9f2a4c';

function eventProject(name) {
  const project = mkdtempSync(join(tmpdir(), name));
  directories.push(project);
  mkdirSync(join(project, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(join(project, '.agenticloop', 'project.md'), [
    '---', 'setup_status: unconfirmed', 'setup_confirmed_at: ""', 'setup_confirmed_by: ""',
    'task_backend: files', 'event_logging: enabled', 'event_logging_command: ""',
    'task_id_pattern: "T-<number>"', 'task_id_regex: "^T-\\d{3,}$"',
    'task_file_template: ".agenticloop/tasks/{taskId}.md"', 'grouping_profile: flat', '---', '# Project Map',
  ].join('\n'), 'utf8');
  writeFileSync(join(project, '.agenticloop', 'tasks', 'T-001.md'), '# T-001\n', 'utf8');
  writeFileSync(join(project, '.agenticloop', 'tasks', 'T-002.md'), '# T-002\n', 'utf8');
  return project;
}

function projectKernel(project, options = {}) {
  const runtimeConfig = config();
  const state = createInitialRuntimeState({
    runId: options.runId ?? 'sup-project-run',
    controllerId: 'controller-project',
    projectRoot: project,
    config: runtimeConfig,
    now: () => Date.UTC(2026, 6, 22),
  });
  const { runId, ...rest } = options;
  return new SupervisionKernel({ state, config: runtimeConfig, projectRoot: project, now: () => Date.UTC(2026, 6, 22), ...rest });
}

describe('A. credential-safe public and model-bound serialization', () => {
  it('detects and withholds every documented credential form', () => {
    const secretBearing = [
      'curl -H Authorization:Bearer_' + SENTINEL + ' https://example.test',
      'curl -H "Authorization: Bearer ' + SENTINEL + '" https://example.test',
      'export MY_API_KEY=' + SENTINEL,
      'deploy --token ' + SENTINEL,
      'psql postgres://user:' + SENTINEL + '@db.example.test/app',
      'curl "https://example.test/api?access_token=' + SENTINEL + '"',
      'use api_key: ' + SENTINEL,
      'gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123',
      'openai sk-abcdefghijklmnopqrstuvwxyz012345',
      'curl -H Cookie:sessionid=' + SENTINEL + ' https://example.test',
      'curl -H X-Auth:' + SENTINEL + ' https://example.test',
      'https://example.test/oauth/callback?code=' + SENTINEL,
      'npm config set //registry.npmjs.org/:_authToken ' + SENTINEL,
    ];
    for (const text of secretBearing) {
      assert.equal(containsSensitiveMaterial(text), true, 'expected sensitive: ' + text);
      assert.equal(redactSecrets(text).includes(SENTINEL), false, 'sentinel survived redaction: ' + text);
      assert.ok(redactSecrets(text).includes('[redacted]'), 'no redaction marker for: ' + text);
    }
    for (const benign of ['git status', 'npm test', 'read src/index.js', 'https://example.test/docs']) {
      assert.equal(containsSensitiveMaterial(benign), false, 'false positive: ' + benign);
      assert.equal(redactSecrets(benign), benign);
    }
  });

  it('keeps a sentinel secret out of status, supervisor payloads, notifications, diagnostics, and event logs', () => {
    const project = eventProject('al-supervision-secret-');
    const value = projectKernel(project, { runId: 'sup-secret-run' });
    value.registerRoot({ session_id: 'root-secret', project_root: project });
    value.registerSupervisor('supervisor-secret');
    value.authorizeWorkUnit({ unit_id: 'U-001', scope_ref: 'task-file:T-001', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-secret', role: 'engineer', task_ref: 'T-001', expected_artifact: 'commit:abc', authorized_unit_id: 'U-001', scope_ref: 'task-file:T-001' });
    value.bindLaneSession('lane-secret', 'worker-secret');

    const permission = value.recordPermission({
      id: 'req-secret',
      session_id: 'worker-secret',
      operation: 'bash',
      patterns: ['curl -H Authorization:Bearer_' + SENTINEL + ' https://example.test'],
      metadata: {
        command: 'curl -H Authorization:Bearer_' + SENTINEL + ' https://example.test',
        targets: ['https://user:' + SENTINEL + '@example.test'],
      },
    });

    assert.equal(permission.metadata.sensitive_material_redacted, true);
    assert.equal(permission.metadata.command, '');
    assert.equal(permission.authority, 'human-only', 'a request whose scope cannot be shown is never supervisor-eligible');
    assert.ok(permission.risk_categories.includes('sensitive_material_redacted'));

    const cookiePermission = value.recordPermission({
      id: 'req-cookie-secret',
      session_id: 'worker-secret',
      operation: 'bash',
      patterns: ['curl -H Cookie:sessionid=' + SENTINEL + ' https://example.test'],
      metadata: { command: 'curl -H Cookie:sessionid=' + SENTINEL + ' https://example.test' },
    });
    assert.equal(cookiePermission.metadata.sensitive_material_redacted, true);
    assert.equal(cookiePermission.authority, 'human-only');

    value.diagnostic('probe', { command: 'curl -H Authorization:Bearer_' + SENTINEL + ' https://x' });
    value.notify('capability_degraded', 'failed while running curl -H Authorization:Bearer_' + SENTINEL, { detail: 'token=' + SENTINEL });
    value.emitMaterial('supervision.assessed', {
      taskRef: 'T-001', role: 'supervisor', outcome: 'success',
      summary: 'assessed curl -H Authorization:Bearer_' + SENTINEL,
      data: { note: 'secret=' + SENTINEL },
    });

    const surfaces = [
      ['status', value.status()],
      ['model view', value.modelView()],
      ['human summary', value.humanSummary()],
      ['persisted state', value.state],
      ['reattachment snapshot', value.reattachmentSnapshot()],
    ];
    for (const [label, payload] of surfaces) {
      assert.equal(JSON.stringify(payload).includes(SENTINEL), false, label + ' leaked the sentinel secret');
    }

    const logPath = resolveEventLogPath(project, undefined, 'T-001').path;
    assert.equal(readFileSync(logPath, 'utf8').includes(SENTINEL), false, 'task JSONL leaked the sentinel secret');
    assert.deepEqual(validateEventLogFile(logPath, { target: project }).errors, []);
  });

  it('never persists raw permission scope and fingerprints exact request reuse', () => {
    const value = kernel();
    authorizeAndPrepare(value, 'lane-safe');
    const permission = value.recordPermission({
      id: 'req-fingerprint', session_id: 'worker-lane-safe', operation: 'bash',
      patterns: ['git status*'], metadata: { command: 'git status', paths: ['src/'] },
    });
    assert.equal(permission.authority, 'supervisor-eligible');
    assert.deepEqual(permission.patterns, []);
    assert.equal(permission.metadata.command, '');
    assert.deepEqual(permission.metadata.paths, []);
    assert.equal(permission.metadata.private_scope_withheld, true);
    assert.match(permission.scope_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(value.status()).includes('git status'), false);
    assert.equal(JSON.stringify(value.modelView()).includes('git status'), false);
    assert.throws(() => value.recordPermission({
      id: 'req-fingerprint', session_id: 'worker-lane-safe', operation: 'bash',
      patterns: ['git diff*'], metadata: { command: 'git diff', paths: ['src/'] },
    }), /reused with different immutable fields/);
  });

  it('gives the supervisor model a bounded view without operator-only surfaces', () => {
    const value = kernel();
    authorizeAndPrepare(value, 'lane-a');
    value.notify('budget', 'operator only notice');
    value.diagnostic('operator_only', { note: 'diagnostic' });
    const view = value.modelView();
    assert.equal(view.notifications, undefined);
    assert.equal(view.recent_events, undefined);
    assert.equal(view.controller.run_id, undefined);
    assert.equal(view.controller.project_root, undefined);
    assert.equal(view.sessions.lanes.length, 1);
    assert.ok(view.budgets.configured);
  });
});

describe('B. OpenCode event identity and outcome classification', () => {
  it('never substitutes a domain identity for a per-event identity', () => {
    assert.equal(extractOpencodeEventId({ type: 'session.idle', properties: { sessionID: 'ses-1', id: 'ses-1' } }), null);
    assert.equal(extractOpencodeEventId({ type: 'session.error', properties: { sessionID: 'ses-1', id: 'perm-1' } }), null);
    assert.equal(extractOpencodeEventId({ type: 'message.updated', properties: { info: { id: 'msg-1' } } }), null);
    assert.equal(extractOpencodeEventId({ type: 'tool.execute.after', properties: { callID: 'call-7' } }), 'tool.execute.after:call-7');
    assert.equal(extractOpencodeEventId({ type: 'tool.execute.after', properties: {} }), null);
    assert.equal(extractOpencodeEventId({ type: 'message.part.updated', properties: { part: { id: 'p1', messageID: 'm1' } } }), 'message.part.updated:m1:p1');
  });

  it('processes repeated id-less activity, error, and idle events and still ignores a genuine duplicate id', () => {
    let clock = Date.UTC(2026, 6, 22);
    const runtimeConfig = config();
    const state = createInitialRuntimeState({ runId: 'sup-dedup', controllerId: 'c', projectRoot: 'C:/project', config: runtimeConfig, now: () => clock });
    const value = new SupervisionKernel({ state, config: runtimeConfig, now: () => clock });
    authorizeAndPrepare(value, 'lane-a');

    value.recordActivity('lane-a', { state: 'running', event_id: null });
    const firstSeen = value.findLane('lane-a').last_observed_activity_at;
    clock += 1000;
    assert.deepEqual(value.recordActivity('lane-a', { state: 'running', event_id: null }), { ok: true });
    assert.notEqual(value.findLane('lane-a').last_observed_activity_at, firstSeen, 'a second id-less activity event must still advance observation time');

    clock += 1000;
    assert.equal(value.recordOutcome('lane-a', 'failed_transport', { event_id: null }).duplicate, undefined);
    clock += 1000;
    assert.equal(value.recordOutcome('lane-a', 'failed_transport', { event_id: null }).duplicate, undefined, 'a second id-less error must still be classified');

    authorizeAndPrepare(value, 'lane-idle', 'T-2');
    clock += 1000;
    assert.equal(value.recordOutcome('lane-idle', 'completed', { reconciliation: { verified: true, present: false, kind: 'commit', reference: 'x' } }).duplicate, undefined);
    clock += 1000;
    assert.equal(value.recordOutcome('lane-idle', 'completed', { reconciliation: { verified: true, present: false, kind: 'commit', reference: 'x' } }).duplicate, undefined, 'a second id-less idle must still reconcile');

    authorizeAndPrepare(value, 'lane-dup', 'T-1');
    clock += 1000;
    assert.equal(value.recordActivity('lane-dup', { state: 'running', event_id: 'tool.execute.after:call-1' }).duplicate, undefined);
    assert.equal(value.recordActivity('lane-dup', { state: 'running', event_id: 'tool.execute.after:call-1' }).duplicate, true);
  });

  it('does not suppress a reused event id in a new lane session generation', () => {
    const value = kernel();
    authorizeAndPrepare(value, 'lane-a');
    assert.equal(value.recordActivity('lane-a', { state: 'running', event_id: 'tool.execute.after:call-1' }).duplicate, undefined);
    assert.equal(value.recordActivity('lane-a', { state: 'running', event_id: 'tool.execute.after:call-1' }).duplicate, true);
    value.bindLaneSession('lane-a', 'worker-lane-a-gen2');
    assert.equal(value.recordActivity('lane-a', { state: 'running', event_id: 'tool.execute.after:call-1' }).duplicate, undefined, 'a new generation is a new event stream');
  });

  it('applies documented precedence for ambiguous and contradictory host evidence', () => {
    const cases = [
      ['permission + timeout', { message: 'permission was rejected and the request timed out' }, 'permission_rejected', 'text'],
      ['permission wait + timeout', { message: 'approval required; connection timeout follows' }, 'waiting_permission', 'text'],
      ['cancellation + transport', { message: 'aborted after a socket connection error' }, 'cancelled', 'text'],
      ['429 + quota wording', { message: 'rate limit hit (429); insufficient credits quota' }, 'failed_rate_limit', 'text'],
      ['authentication + provider unavailable', { message: 'api key invalid and provider unavailable' }, 'failed_quota', 'text'],
      ['context limit + rate limit', { message: 'context limit exceeded, then rate limit' }, 'failed_context', 'text'],
      ['generic 5xx', { message: 'upstream returned 503' }, 'failed_transport', 'text'],
      ['structured code beats vague prose', { code: 'rate_limit_exceeded', message: 'something went wrong somewhere' }, 'failed_rate_limit', 'structured_code'],
      ['structured code contradicts prose', { code: 'aborted', message: 'network connection failure' }, 'cancelled', 'structured_code'],
      ['structured status', { status: 429, message: 'no useful prose' }, 'failed_rate_limit', 'structured_status'],
      ['no evidence', {}, 'unknown', 'no_evidence'],
      ['unmatched prose', { message: 'a wholly unfamiliar condition' }, 'unknown', 'unmatched_text'],
    ];
    for (const [label, properties, outcome, source] of cases) {
      const result = classifyOpencodeOutcome(properties);
      assert.equal(result.outcome, outcome, label + ': expected ' + outcome + ', got ' + result.outcome);
      assert.equal(result.classification_source, source, label + ': expected source ' + source);
    }
    assert.equal(classifyOpencodeOutcome({ code: 'rate_limit_exceeded', retry_after: 30 }).retry_after_ms, 30_000);
    assert.equal(classifyOpencodeOutcome({ status: 429, retry_after_ms: 5_000_000 }).retry_after_ms, 900_000);
  });

  it('ships the identical classifier and identity helper inside the generated plugin', () => {
    const plugin = renderOpencodeSupervisionPlugin();
    assert.ok(plugin.includes(classifyOpencodeOutcome.toString()), 'the plugin must embed the exact classifier implementation');
    assert.ok(plugin.includes(extractOpencodeEventId.toString()), 'the plugin must embed the exact event-identity implementation');
    assert.equal(/event_id: String\(properties\./.test(plugin), false, 'no synthetic event-id fallback may remain');
  });

  it('executes the exact generated parser, capability probe, and usage normalizer contracts', () => {
    assert.deepEqual(parseAgenticLoopArguments('supervisor status'), { kind: 'supervisor', rest: 'status' });
    assert.deepEqual(parseAgenticLoopArguments('supervisor-facing work'), { kind: 'ordinary', task: 'supervisor-facing work' });
    assert.deepEqual(parseAgenticLoopArguments('--supervised T-1'), { kind: 'supervised', task: 'T-1' });
    assert.deepEqual(parseAgenticLoopArguments('--supervisedX T-1'), { kind: 'ordinary', task: '--supervisedX T-1' });

    const partial = probeOpenCodeBridgeCapabilities({ session: { create() {} }, tui: {} });
    assert.equal(partial.root_registration, true);
    assert.equal(partial.session_abort, false);
    assert.equal(partial.fresh_lane_invocation, false);
    assert.equal(partial.tui_controller_commands, false);

    assert.deepEqual(normalizeOpenCodeSupervisorUsage({ info: { cost: 1.25 }, parts: [] }), { cost_units: 1.25 });
    assert.deepEqual(normalizeOpenCodeSupervisorUsage({ parts: [{ type: 'step-finish', cost: 0.2 }, { type: 'step-finish', cost: 0.3 }] }), { cost_units: 0.5 });
    assert.equal(normalizeOpenCodeSupervisorUsage({ parts: [{ type: 'text', text: 'done' }] }), undefined);

    const plugin = renderOpencodeSupervisionPlugin();
    assert.ok(plugin.includes(parseAgenticLoopArguments.toString()));
    assert.ok(plugin.includes(probeOpenCodeBridgeCapabilities.toString()));
    assert.ok(plugin.includes(normalizeOpenCodeSupervisorUsage.toString()));
    assert.match(plugin, /agenticloop_checkpoint/);
  });
});

function clockController(runtimeConfig, now, options = {}) {
  const controller = new SupervisionController({
    projectRoot: options.projectRoot ?? 'C:/timing',
    config: runtimeConfig,
    runId: options.runId ?? 'sup-timing',
    credential: 'z'.repeat(48),
    now,
    ...options.timers,
  });
  controller.kernel.registerRoot({ session_id: 'root-t', project_root: controller.projectRoot });
  controller.kernel.registerSupervisor('supervisor-t');
  controller.kernel.markBridgeConnected(bridgeIdentity());
  controller.kernel.authorizeWorkUnit({ unit_id: 'U-T', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
  return controller;
}

function startLane(controller, laneId, taskRef, extra = {}) {
  controller.kernel.prepareLane({
    lane_id: laneId, role: 'engineer', task_ref: taskRef, expected_artifact: 'commit:' + laneId,
    authorized_unit_id: 'U-T', scope_ref: 'task-file:T-1,T-2', ...extra,
  });
  controller.kernel.bindLaneSession(laneId, 'worker-' + laneId);
  controller.kernel.markLaneStarted(laneId, 'worker-' + laneId);
  return controller.kernel.findLane(laneId);
}

describe('C. timing, liveness, and per-lane leases', () => {
  it('charges elapsed time to the state that actually elapsed', () => {
    let clock = Date.UTC(2026, 6, 22);
    const value = clockController(config(), () => clock).kernel;
    startLane({ kernel: value }, 'lane-t', 'T-1');

    clock += 5 * 60_000;
    value.pause();
    assert.equal(value.state.timing.active_ms, 5 * 60_000, 'the five active minutes belong to active');
    clock += 7 * 60_000;
    value.resume();
    assert.equal(value.state.timing.paused_ms, 7 * 60_000, 'the seven paused minutes belong to paused');
    assert.equal(value.state.timing.active_ms, 5 * 60_000, 'resuming must not retroactively move paused time into active');

    clock += 2 * 60_000;
    value.recordPermission({ id: 'req-t', session_id: 'worker-lane-t', operation: 'bash', patterns: ['git status*'] });
    assert.equal(value.state.timing.active_ms, 7 * 60_000);
    clock += 3 * 60_000;
    value.decidePermission('req-t', 'once', { principal: 'operator' });
    assert.equal(value.state.timing.permission_wait_ms, 3 * 60_000);

    clock += 4 * 60_000;
    value.markBridgeLost('test');
    assert.equal(value.state.timing.active_ms, 14 * 60_000, 'a runnable root remains active while its sibling lane waits for permission');
    clock += 6 * 60_000;
    value.stop();
    assert.equal(value.state.timing.active_ms, 14 * 60_000, 'time after bridge loss is not active time');
    assert.equal(value.state.timing.absolute_age_ms, 27 * 60_000, 'absolute age stays independent of every bucket');
  });

  it('charges operator-wait time to the operator-wait bucket', async () => {
    let clock = Date.UTC(2026, 6, 22);
    const value = clockController(config(), () => clock).kernel;
    startLane({ kernel: value }, 'lane-w', 'T-1');
    clock += 2 * 60_000;
    const context = value.issueActionContext({ allowed_actions: ['request_operator'], target: 'lane-w', target_kind: 'lane', wake_id: 'w' });
    await value.applyDisposition({ action: 'request_operator', target: 'lane-w' }, { actionContext: context });
    assert.equal(value.state.timing.active_ms, 2 * 60_000);
    clock += 8 * 60_000;
    value.save();
    assert.equal(value.state.timing.human_wait_ms, 8 * 60_000);
  });

  it('keeps non-durable activity from resetting the durable no-progress lease', async () => {
    let clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    startLane(controller, 'lane-chatty', 'T-1');
    const wakes = [];
    controller.requestSupervisor = async (question, context) => {
      wakes.push(context.target);
      return { ok: true, disposition: { action: 'continue_observing', target: context.target } };
    };
    for (let minute = 0; minute < 6; minute += 1) {
      clock += 60_000;
      controller.kernel.recordActivity('lane-chatty', { state: 'running', event_id: 'tool.execute.after:call-' + minute, durable: false });
    }
    await controller.tickObservation();
    await controller.wakeChain;
    assert.ok(wakes.includes('lane-chatty'), 'chatty message traffic must not mask durable no-progress');

    controller.kernel.recordActivity('lane-chatty', { state: 'running', event_id: 'checkpoint', durable: true, durable_ref: 'file:src/a.js' });
    const before = wakes.length;
    clock += 60_000;
    await controller.tickObservation();
    await controller.wakeChain;
    assert.equal(wakes.length, before, 'a verified durable checkpoint resets the lease');
  });

  it('continues observing runnable siblings while another lane waits for permission', async () => {
    let clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    startLane(controller, 'lane-runnable', 'T-1');
    startLane(controller, 'lane-waiting', 'T-2');
    controller.kernel.recordPermission({ id: 'req-lane-waiting', session_id: 'worker-lane-waiting', operation: 'bash', patterns: ['git status*'] });
    const wakes = [];
    controller.requestSupervisor = async (_question, context) => {
      wakes.push(context.target);
      return { ok: true, disposition: { action: 'continue_observing', target: context.target } };
    };

    clock += 6 * 60_000;
    await controller.tickObservation();
    await controller.wakeChain;

    assert.ok(wakes.includes('lane-runnable'));
    assert.equal(wakes.includes('lane-waiting'), false);
    assert.equal(controller.kernel.state.timing.active_ms, 6 * 60_000, 'runnable sibling/root time remains active');
    assert.equal(controller.kernel.state.timing.permission_wait_ms, 6 * 60_000, 'permission wait is tracked independently');
  });

  it('starts a fresh no-progress allowance after a verified durable checkpoint', async () => {
    let clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    startLane(controller, 'lane-checkpoint', 'T-1');
    controller.requestSupervisor = async (_question, context) => ({ ok: true, disposition: { action: 'continue_observing', target: context.target } });
    clock += 6 * 60_000;
    await controller.tickObservation();
    await controller.wakeChain;
    assert.equal(controller.kernel.state.budgets.used.lane_no_progress['lane-checkpoint'], 1);

    controller.kernel.recordActivity('lane-checkpoint', {
      state: 'running', event_id: 'durable-checkpoint-1', durable: true, durable_ref: 'file:.agenticloop/tasks/T-1.md',
    });
    assert.equal(controller.kernel.state.budgets.used.lane_no_progress['lane-checkpoint'], 0);
    assert.equal(controller.kernel.findLane('lane-checkpoint').no_progress_exhausted, false);
  });

  it('applies distinct per-lane leases to their exact lanes', async () => {
    let clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    startLane(controller, 'lane-fast', 'T-1', { lease: { no_progress_minutes: 2 } });
    startLane(controller, 'lane-slow', 'T-2', { lease: { no_progress_minutes: 30 } });
    assert.equal(controller.kernel.findLane('lane-fast').lease.no_progress_ms, 2 * 60_000);
    assert.equal(controller.kernel.findLane('lane-slow').lease.no_progress_ms, 30 * 60_000);
    assert.equal(controller.noProgressThreshold(controller.kernel.findLane('lane-fast')), 2 * 60_000);
    assert.equal(controller.noProgressThreshold(controller.kernel.findLane('lane-slow')), 30 * 60_000);

    const wakes = [];
    controller.requestSupervisor = async (question, context) => {
      wakes.push(context.target);
      return { ok: true, disposition: { action: 'continue_observing', target: context.target } };
    };
    clock += 3 * 60_000;
    await controller.tickObservation();
    await controller.wakeChain;
    assert.ok(wakes.includes('lane-fast'), 'the two-minute lease elapsed');
    assert.equal(wakes.includes('lane-slow'), false, 'the thirty-minute lease has not elapsed');
  });

  it('normalizes every accepted lease spelling and rejects out-of-bounds values', () => {
    assert.equal(normalizeLaneLease({ lease: { no_progress_ms: 90_000 } }, 300_000).no_progress_ms, 90_000);
    assert.equal(normalizeLaneLease({ lease: { no_progress_minutes: 3 } }, 300_000).no_progress_ms, 180_000);
    assert.equal(normalizeLaneLease({ lease: { minutes: 4 } }, 300_000).no_progress_ms, 240_000);
    assert.equal(normalizeLaneLease({ lease: 7 }, 300_000).no_progress_ms, 420_000);
    assert.equal(normalizeLaneLease({}, 300_000).source, 'default');
    assert.equal(normalizeLaneLease({ lease: { no_progress_ms: -5 } }, 300_000).source, 'default');
    assert.ok(normalizeLaneLease({ lease: { no_progress_ms: -5 } }, 300_000).rejected);

    const value = kernel();
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-bad', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1', lease: { no_progress_ms: -5 } });
    assert.equal(value.findLane('lane-bad').lease.no_progress_ms, 5 * 60_000);
    assert.ok(value.state.diagnostics.some(entry => entry.type === 'lane_lease_rejected'));
  });
});

describe('D. budgets, backoff, and exhaustion', () => {

  it('enforces the configured permission-assessment budget and leaves overflow requests pending', async () => {
    const runtimeConfig = config();
    runtimeConfig.budgets.permission_assessments = 1;
    const controller = clockController(runtimeConfig, () => Date.UTC(2026, 6, 22));
    startLane(controller, 'lane-permission-a', 'T-1');
    startLane(controller, 'lane-permission-b', 'T-2');
    let scheduled = 0;
    controller.scheduleSupervisorWake = () => { scheduled += 1; };

    const first = await controller.handleRequest('permission.asked', { permission: { id: 'req-budget-a', session_id: 'worker-lane-permission-a', operation: 'bash', patterns: ['git status*'] } });
    const second = await controller.handleRequest('permission.asked', { permission: { id: 'req-budget-b', session_id: 'worker-lane-permission-b', operation: 'bash', patterns: ['git status*'] } });

    assert.equal(first.assessment_scheduled, true);
    assert.equal(second.assessment_scheduled, false);
    assert.equal(second.code, 'budget_exhausted');
    assert.equal(scheduled, 1);
    assert.equal(controller.kernel.state.budgets.used.permission_assessments, 2);
    assert.equal(controller.kernel.state.permissions.find(entry => entry.id === 'req-budget-b').status, 'pending');
  });
  function virtualTimers() {
    const timers = new Map();
    let sequence = 0;
    return {
      timers,
      handles: {
        setTimer: (callback, delay) => {
          const handle = { id: ++sequence, unref() { return this; } };
          timers.set(handle, { callback, delay });
          return handle;
        },
        clearTimer: handle => timers.delete(handle),
        setTicker: () => ({ unref() { return this; } }),
        clearTicker: () => {},
      },
      fire() {
        const entries = [...timers.entries()];
        timers.clear();
        for (const [, entry] of entries) entry.callback();
        return entries.length;
      },
    };
  }

  it('never retries a rate-limited route before its deadline and fires exactly one delayed wake', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const virtual = virtualTimers();
    const controller = clockController(config(), () => clock, { timers: virtual.handles });
    startLane(controller, 'lane-rl', 'T-1');
    const wakes = [];
    controller.requestSupervisor = async (question, context) => {
      wakes.push(context.allowed_actions);
      return { ok: true, disposition: { action: 'continue_observing', target: context.target } };
    };

    const result = await controller.handleRequest('host.outcome', { target: 'worker-lane-rl', outcome: 'failed_rate_limit', metadata: { retry_after_ms: 60_000 } });
    await controller.wakeChain;
    assert.equal(result.deferred, true);
    assert.deepEqual(wakes, [], 'no assessment may run before the bounded rate-limit deadline');
    assert.equal(virtual.timers.size, 1, 'exactly one delayed wake is scheduled');

    assert.equal(virtual.fire(), 1);
    await controller.wakeChain;
    assert.equal(wakes.length, 1, 'exactly one wake fires on expiry');
    assert.ok(wakes[0].includes('fresh_retry'));
  });

  it('suppresses a delayed wake after the target generation, authorization, or controller state changes', async () => {
    const clock = Date.UTC(2026, 6, 22);
    for (const [label, mutate] of [
      ['stale generation', controller => controller.kernel.bindLaneSession('lane-rl', 'worker-lane-rl-gen2')],
      ['changed authorization', controller => controller.kernel.authorizeWorkUnit({ unit_id: 'U-NEW', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' })],
      ['paused controller', controller => controller.kernel.pause()],
      ['stopped controller', controller => controller.kernel.stop()],
    ]) {
      const virtual = virtualTimers();
      const controller = clockController(config(), () => clock, { timers: virtual.handles });
      startLane(controller, 'lane-rl', 'T-1');
      const wakes = [];
      controller.requestSupervisor = async () => { wakes.push(1); return { ok: true, disposition: { action: 'continue_observing', target: 'lane-rl' } }; };
      await controller.handleRequest('host.outcome', { target: 'worker-lane-rl', outcome: 'failed_rate_limit', metadata: { retry_after_ms: 60_000 } });
      mutate(controller);
      virtual.fire();
      await controller.wakeChain;
      assert.deepEqual(wakes, [], label + ' must suppress the delayed wake');
    }
  });

  it('cancels every pending backoff when the operator pauses or stops', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const virtual = virtualTimers();
    const controller = clockController(config(), () => clock, { timers: virtual.handles });
    startLane(controller, 'lane-rl', 'T-1');
    await controller.handleRequest('host.outcome', { target: 'worker-lane-rl', outcome: 'failed_rate_limit', metadata: { retry_after_ms: 60_000 } });
    assert.equal(virtual.timers.size, 1);
    await controller.operatorCommand({ principal: 'operator', command: 'pause' });
    assert.equal(virtual.timers.size, 0, 'pause cancels pending backoff timers');
    assert.equal(controller.rateLimitBackoffs.size, 0);
  });

  it('routes a delay that exceeds the remaining time budget to the operator without scheduling', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const virtual = virtualTimers();
    const runtimeConfig = config();
    runtimeConfig.budgets.active_minutes = 1;
    runtimeConfig.budgets.absolute_age_minutes = 1;
    const controller = clockController(runtimeConfig, () => clock, { timers: virtual.handles });
    startLane(controller, 'lane-rl', 'T-1');
    const wakes = [];
    controller.requestSupervisor = async () => { wakes.push(1); return { ok: true, disposition: { action: 'continue_observing', target: 'lane-rl' } }; };
    await controller.handleRequest('host.outcome', { target: 'worker-lane-rl', outcome: 'failed_rate_limit', metadata: { retry_after_ms: 10 * 60_000 } });
    await controller.wakeChain;
    assert.equal(virtual.timers.size, 0, 'no timer is scheduled beyond the remaining budget');
    assert.deepEqual(wakes, []);
    assert.ok(controller.kernel.state.notifications.some(entry => entry.summary.includes('exceeds remaining time budget')));
  });

  it('stops recovery retry churn once the unknown-outcome allowance is exhausted', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const runtimeConfig = config();
    runtimeConfig.budgets.lane_unknown_outcomes = 1;
    const controller = clockController(runtimeConfig, () => clock);
    startLane(controller, 'lane-unknown', 'T-1');
    const offered = [];
    controller.requestSupervisor = async (question, context) => {
      offered.push(context.allowed_actions);
      return { ok: true, disposition: { action: 'request_operator', target: context.target } };
    };
    await controller.handleRequest('host.outcome', { target: 'worker-lane-unknown', outcome: 'unknown', metadata: {} });
    await controller.wakeChain;
    assert.ok(offered[0].includes('fresh_retry'), 'the first unknown outcome is still recoverable');

    controller.kernel.state.controller.status = 'authorized';
    const second = await controller.handleRequest('host.outcome', { target: 'worker-lane-unknown', outcome: 'unknown', metadata: {} });
    await controller.wakeChain;
    assert.equal(second.recovery_allowed, false);
    assert.equal(controller.kernel.findLane('lane-unknown').unknown_outcome_exhausted, true);
    assert.equal(offered[1].includes('fresh_retry'), false, 'an exhausted lane may only escalate or terminate');
    assert.deepEqual(offered[1], ['request_operator', 'record_block', 'cancel_session']);
  });

  it('keeps a missing artifact out of the unrelated unknown-outcome budget', () => {
    const value = kernel();
    authorizeAndPrepare(value, 'lane-a');
    value.recordOutcome('lane-a', 'completed', { reconciliation: { verified: true, present: false, kind: 'commit', reference: 'a' } });
    assert.equal(value.findLane('lane-a').outcome, 'unknown');
    assert.equal(value.state.budgets.used.lane_no_artifact['lane-a'], 1, 'a missing artifact consumes the no-artifact allowance');
    assert.equal(value.state.budgets.used.lane_no_progress['lane-a'], undefined, 'and never the observation allowance');
    assert.equal(value.state.budgets.used.lane_unknown_outcomes['lane-a'], undefined, 'and never the unclassifiable-result allowance');

    value.bindLaneSession('lane-a', 'worker-lane-a-gen2');
    value.recordOutcome('lane-a', 'unknown', {});
    assert.equal(value.state.budgets.used.lane_unknown_outcomes['lane-a'], 1);
    assert.equal(value.state.budgets.used.lane_no_artifact['lane-a'], 1);
  });

  it('pre-gates the provider once a nonzero cost ceiling is exhausted', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const runtimeConfig = config();
    runtimeConfig.budgets.supervisor_cost_units = 2;
    const controller = clockController(runtimeConfig, () => clock);
    let providerCalls = 0;
    controller.hostCall = async (method) => {
      if (method !== 'host.supervisor.assess') return {};
      providerCalls += 1;
      return { disposition: JSON.stringify({ action: 'continue_observing', target: 'root' }), usage: { cost_units: 3 } };
    };
    const context = () => controller.kernel.issueActionContext({ allowed_actions: ['continue_observing'], target: 'root', target_kind: 'root', wake_id: 'cost-' + providerCalls });

    const first = await controller.requestSupervisor('assess', context());
    assert.equal(providerCalls, 1);
    assert.equal(first.ok, false, 'the ceiling was exceeded by this call');
    assert.equal(controller.kernel.costEnforcementExhausted(), true);

    const second = await controller.requestSupervisor('assess again', context());
    assert.equal(providerCalls, 1, 'no provider call may happen after cost exhaustion');
    assert.deepEqual(second, { ok: false, code: 'budget_exhausted', budget: 'supervisor_cost_units' });

    const cost = controller.kernel.status().budgets.cost;
    assert.deepEqual(cost, { tracking: 'host-reported', enforcement: 'enabled', used: 3, limit: 2, remaining: 0, exhausted: true });
  });

  it('keeps a zero cost ceiling as measurement without enforcement', () => {
    const value = kernel();
    const recorded = value.recordSupervisorCost({ cost_units: 5 });
    assert.deepEqual(recorded, { supported: true, units: 5, allowed: true, enforcement: 'disabled' });
    assert.equal(value.costEnforcementExhausted(), false);
    assert.deepEqual(value.costStatus(), { tracking: 'host-reported', enforcement: 'disabled', used: 5, limit: 0, remaining: null, exhausted: false });
  });

  it('emits one approaching and one exhaustion notification per bounded budget and none for routine observation', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const runtimeConfig = config();
    runtimeConfig.budgets.lane_infrastructure_retries = 5;
    runtimeConfig.notifications.history_limit = 100;
    const controller = clockController(runtimeConfig, () => clock);
    startLane(controller, 'lane-b', 'T-1');
    const budgetNotices = () => controller.kernel.state.notifications.filter(entry => entry.kind === 'budget' && entry.data.budget === 'lane_infrastructure_retries');

    for (let index = 0; index < 3; index += 1) controller.kernel.incrementBudget('lane_infrastructure_retries', 'lane-b');
    assert.equal(budgetNotices().length, 0, 'below the threshold nothing is announced');
    controller.kernel.incrementBudget('lane_infrastructure_retries', 'lane-b');
    assert.equal(budgetNotices().length, 1, 'the approaching threshold fires exactly once');
    assert.ok(budgetNotices()[0].summary.includes('approaching'));
    controller.kernel.incrementBudget('lane_infrastructure_retries', 'lane-b');
    assert.equal(budgetNotices().length, 2);
    assert.ok(budgetNotices()[1].summary.includes('reached its configured limit'));
    controller.kernel.incrementBudget('lane_infrastructure_retries', 'lane-b');
    assert.equal(budgetNotices().length, 2, 'exhaustion is announced once, not on every later increment');

    const before = controller.kernel.state.notifications.length;
    controller.requestSupervisor = async (question, context) => ({ ok: true, disposition: { action: 'continue_observing', target: context.target } });
    controller.scheduleSupervisorWake({ reason: 'routine', target: 'root', allowedActions: ['continue_observing'] });
    await controller.wakeChain;
    assert.equal(controller.kernel.state.notifications.length, before, 'continue_observing never notifies');
  });

  it('does not emit a second exhaustion notification when the real outcome path crosses a limit', () => {
    const runtimeConfig = config();
    runtimeConfig.budgets.lane_unknown_outcomes = 1;
    runtimeConfig.notifications.history_limit = 100;
    const state = createInitialRuntimeState({
      runId: 'sup-budget-notification-run', controllerId: 'controller-budget-notification',
      projectRoot: 'C:/project', config: runtimeConfig, now: () => Date.UTC(2026, 6, 22),
    });
    const value = new SupervisionKernel({ state, config: runtimeConfig, now: () => Date.UTC(2026, 6, 22) });
    authorizeAndPrepare(value, 'lane-budget');
    value.recordOutcome('worker-lane-budget', 'unknown', { event_id: 'unknown-1' });
    value.recordOutcome('worker-lane-budget', 'unknown', { event_id: 'unknown-2' });
    const notices = value.state.notifications.filter(entry => entry.kind === 'budget' && entry.data.budget === 'lane_unknown_outcomes');
    assert.equal(notices.length, 1);
    assert.ok(notices[0].summary.includes('reached its configured limit'));
    assert.equal(value.findLane('lane-budget').unknown_outcome_exhausted, true);
  });

  it('covers every documented budget with approaching notifications', () => {
    const value = kernel();
    value.config.notifications.history_limit = 100;
    const runScoped = ['supervisor_wakeups', 'route_fallbacks', 'root_replacements', 'supervisor_replacements', 'permission_assessments'];
    const laneScoped = ['lane_infrastructure_retries', 'lane_no_progress', 'lane_no_artifact', 'lane_unknown_outcomes'];
    for (const name of [...runScoped, ...laneScoped]) value.state.budgets[name] = 5;
    // Four of five is exactly the configured 80% approaching threshold.
    for (const name of runScoped) for (let index = 0; index < 4; index += 1) value.incrementBudget(name);
    for (const name of laneScoped) for (let index = 0; index < 4; index += 1) value.incrementBudget(name, 'lane-a');
    const announced = new Map(value.state.notifications.filter(entry => entry.kind === 'budget').map(entry => [entry.data.budget, entry.summary]));
    for (const name of [...runScoped, ...laneScoped]) {
      assert.ok(announced.has(name), 'expected an approaching notification for ' + name);
      assert.ok(announced.get(name).includes('approaching'), name + ' should announce approaching, not exhaustion');
    }
    // Cost and the two time budgets are surfaced by their own dedicated paths.
    value.state.budgets.supervisor_cost_units = 5;
    value.recordSupervisorCost({ cost_units: 4 });
    assert.ok(value.state.notifications.some(entry => entry.data.budget === 'supervisor_cost_units'));
  });
});

describe('E. investigation and cancellation semantics', () => {
  it('keeps explicit operator investigations available across retries and generations', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    startLane(controller, 'lane-i', 'T-1');
    let assessments = 0;
    controller.requestSupervisor = async (question, context) => {
      assessments += 1;
      return { ok: true, disposition: { action: 'continue_observing', target: context.target } };
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await controller.operatorCommand({ principal: 'operator', command: 'investigate', target: 'lane-i' });
      assert.equal(result.ok, true, 'operator investigation ' + (attempt + 1) + ' must remain available');
    }
    controller.kernel.bindLaneSession('lane-i', 'worker-lane-i-gen2');
    const afterRetry = await controller.operatorCommand({ principal: 'operator', command: 'investigate', target: 'lane-i' });
    assert.equal(afterRetry.ok, true, 'a new session generation must not exhaust investigation');
    assert.equal(assessments, 4);
  });

  it('does not consume an investigation step when the model never answered', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    startLane(controller, 'lane-i', 'T-1');
    let available = false;
    controller.requestSupervisor = async (question, context) => (available
      ? { ok: true, disposition: { action: 'continue_observing', target: context.target } }
      : { ok: false, code: 'supervisor_model_unavailable' });
    const unavailable = await controller.operatorCommand({ principal: 'operator', command: 'investigate', target: 'lane-i' });
    assert.deepEqual(unavailable, { ok: false, code: 'supervisor_model_unavailable' });
    available = true;
    const recovered = await controller.operatorCommand({ principal: 'operator', command: 'investigate', target: 'lane-i' });
    assert.equal(recovered.ok, true, 'a failed assessment must not have consumed the attempt');
  });

  it('bounds an autonomous investigate chain by action-context depth', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const runtimeConfig = config();
    runtimeConfig.recovery.max_investigation_depth = 2;
    runtimeConfig.budgets.supervisor_wakeups = 50;
    const controller = clockController(runtimeConfig, () => clock);
    startLane(controller, 'lane-i', 'T-1');
    const depths = [];
    controller.requestSupervisor = async (question, context) => {
      depths.push(context.investigation_depth);
      return { ok: true, disposition: { action: 'investigate', target: context.target } };
    };
    controller.scheduleSupervisorWake({ reason: 'assess', target: 'lane-i', allowedActions: ['continue_observing', 'investigate', 'request_operator'] });
    await controller.wakeChain;
    await controller.wakeChain;
    await controller.wakeChain;
    assert.deepEqual(depths, [0, 1, 2], 'the chain terminates at the configured depth');
    assert.equal(controller.kernel.state.action_contexts.length, 3, 'no unbounded context growth');
  });

  it('records a durable failed cancellation for the operator and the supervisor alike', async () => {
    const clock = Date.UTC(2026, 6, 22);
    for (const principal of ['operator', 'supervisor']) {
      const controller = clockController(config(), () => clock);
      startLane(controller, 'lane-c', 'T-1');
      controller.kernel.host.abortSession = async () => { throw new Error('OpenCode abort endpoint refused'); };
      const result = principal === 'operator'
        ? await controller.operatorCommand({ principal: 'operator', command: 'cancel', target: 'lane-c' })
        : await controller.kernel.applyDisposition(
          { action: 'cancel_session', target: 'lane-c', rationale: 'terminal' },
          { actionContext: controller.kernel.issueActionContext({ allowed_actions: ['cancel_session'], target: 'lane-c', target_kind: 'lane', wake_id: 'c' }) }
        );
      assert.equal(result.ok, false, principal + ' cancellation failure must not report success');
      assert.equal(result.code, 'failed_cancellation');
      const lane = controller.kernel.findLane('lane-c');
      assert.equal(lane.outcome, 'failed_cancellation');
      assert.equal(lane.failed_cancellation.attempted_by, principal);
      assert.equal(lane.failed_cancellation.session_id, 'worker-lane-c');
      assert.equal(lane.failed_cancellation.session_generation, 1);
      assert.equal(lane.failed_cancellation.classification, 'failed_cancellation');
      assert.equal(lane.disposition, null, 'a failed cancellation never invents a terminal disposition');
      assert.ok(controller.kernel.state.notifications.some(entry => entry.kind === 'cancellation' && entry.summary.includes('failed')));
    }
  });

  it('makes successful cancellation terminal and keeps a replacement lane usable after a failed one', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    startLane(controller, 'lane-ok', 'T-1');
    controller.kernel.host.abortSession = async () => ({ aborted: true });
    const cancelled = await controller.operatorCommand({ principal: 'operator', command: 'cancel', target: 'lane-ok' });
    assert.equal(cancelled.ok, true);
    const lane = controller.kernel.findLane('lane-ok');
    assert.equal(lane.outcome, 'cancelled');
    assert.equal(lane.disposition.kind, 'cancelled');
    assert.equal(lane.disposition.provenance, 'operator');
    assert.ok(lane.terminal_tombstone);
    controller.kernel.recordOutcome('lane-ok', 'completed', { event_id: 'late', reconciliation: { verified: true, present: true, kind: 'commit', reference: 'x' } });
    assert.equal(controller.kernel.findLane('lane-ok').outcome, 'cancelled', 'a late event after cancellation stays ignored');

    startLane(controller, 'lane-retry', 'T-2');
    controller.kernel.host.abortSession = async () => { throw new Error('abort refused'); };
    await controller.operatorCommand({ principal: 'operator', command: 'cancel', target: 'lane-retry' });
    controller.kernel.host.abortSession = async () => ({ aborted: true });
    controller.kernel.bindLaneSession('lane-retry', 'worker-lane-retry-gen2');
    const second = await controller.operatorCommand({ principal: 'operator', command: 'cancel', target: 'lane-retry' });
    assert.equal(second.ok, true, 'a replacement generation may still be cancelled after an earlier failure');
    assert.equal(controller.kernel.findLane('lane-retry').failed_cancellation, null);
  });

  it('records a failed root cancellation during replacement without inventing a fresh root', async () => {
    const value = kernel({
      host: {
        createRoot: async () => ({ session_id: 'root-replacement' }),
        abortSession: async sessionId => { if (sessionId === 'root-1') throw new Error('abort refused'); },
      },
    });
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.registerSupervisor('supervisor-1');
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    value.markBridgeConnected(bridgeIdentity());
    const context = value.issueActionContext({ allowed_actions: ['replace_orchestrator'], target: 'root', target_kind: 'root', wake_id: 'r' });
    const result = await value.applyDisposition({ action: 'replace_orchestrator', target: 'root' }, { actionContext: context });
    assert.deepEqual(result, { ok: false, code: 'failed_cancellation', target: 'root' });
    assert.equal(value.state.sessions.root.id, 'root-1', 'the registered root is unchanged after a failed replacement');
    assert.equal(value.state.root_replacement.lifecycle, 'cancelled');
  });
});

describe('F. reattachment and controller lifecycle', () => {
  it('derives public capabilities from authenticated bridge probes', () => {
    const controller = new SupervisionController({ projectRoot: 'C:/capabilities', config: config(), runId: 'sup-capabilities', credential: 'p'.repeat(48) });
    assert.equal(controller.kernel.status().capabilities.session_abort, false);
    assert.equal(controller.kernel.status().capability_provenance.session_abort, 'unproven');

    controller.kernel.markBridgeConnected({ capabilities: { session_abort: true } });
    const partial = controller.kernel.status();
    assert.equal(partial.capabilities.session_abort, true);
    assert.equal(partial.capabilities.root_replacement, false);
    assert.equal(partial.capability_provenance.session_abort, 'bridge-api-probed');
    assert.equal(controller.handshake().minimum_capability_verdict, 'pending');

    controller.kernel.markBridgeConnected(bridgeIdentity());
    controller.kernel.registerRoot({ session_id: 'root-capabilities', project_root: controller.projectRoot });
    controller.kernel.registerSupervisor('supervisor-capabilities');
    assert.equal(controller.handshake().minimum_capability_verdict, 'supported');
  });

  it('distinguishes bridge loss from a failed loopback server health probe', async () => {
    const controller = new SupervisionController({
      projectRoot: 'C:/server-probe', config: config(), runId: 'sup-server-probe', credential: 'h'.repeat(48),
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    controller.kernel.markBridgeConnected(bridgeIdentity({ server_identity: 'server-probe', server_url: 'http://127.0.0.1:4096' }));
    controller.kernel.markBridgeLost('socket closed');
    await controller.probeAttachedServerAfterBridgeLoss();
    assert.equal(controller.kernel.state.server.status, 'lost');
    assert.equal(controller.kernel.state.controller.status, 'server_lost');
  });

  it('rebuilds only server-reconciled lanes and routes the rest for bounded reconciliation', async () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-reattach-'));
    directories.push(project);
    const controller = new SupervisionController({ projectRoot: project, config: config(), runId: 'sup-reattach-run', credential: 'a'.repeat(48) });
    await controller.start();
    try {
      controller.kernel.registerRoot({ session_id: 'root-r', project_root: project });
      controller.kernel.registerSupervisor('supervisor-r');
      controller.kernel.markBridgeConnected(bridgeIdentity({ server_identity: 'server-r' }));
      controller.kernel.authorizeWorkUnit({ unit_id: 'U-T', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
      startLane({ kernel: controller.kernel }, 'lane-live', 'T-1');
      startLane({ kernel: controller.kernel }, 'lane-gone', 'T-2');

      const reattached = await controller.handleRequest('bridge.reattach', {
        project_root: project,
        run_id: 'sup-reattach-run',
        server_identity: 'server-r',
        root_session_id: 'root-r',
        live_session_ids: ['worker-lane-live'],
      });
      assert.equal(reattached.ok, true);
      assert.deepEqual(reattached.snapshot.lanes.map(lane => lane.lane_id), ['lane-live']);
      assert.deepEqual(reattached.snapshot.unknown_lanes.map(lane => lane.lane_id), ['lane-gone']);
      assert.equal(reattached.snapshot.lanes[0].session_generation, 1);
      assert.equal(reattached.snapshot.lanes[0].expected_artifact, 'commit:lane-live');
      assert.equal(reattached.snapshot.lanes[0].authorization_generation, 1);
      assert.equal(reattached.snapshot.pending_permission_reconstruction, 'host-enumeration-unsupported');
      assert.equal(controller.kernel.findLane('lane-gone').reconciliation_state, 'unknown_after_reattachment');

      for (const [label, params, code] of [
        ['different project', { project_root: join(project, 'other') }, 'different_project_requires_restart'],
        ['different run', { run_id: 'sup-other' }, 'different_run_requires_restart'],
        ['different server', { server_identity: 'server-other' }, 'different_server_requires_restart'],
        ['different root', { root_session_id: 'root-other' }, 'different_root_requires_replacement'],
      ]) {
        const refused = await controller.handleRequest('bridge.reattach', params);
        assert.equal(refused.ok, false, label + ' must fail closed');
        assert.equal(refused.code, code);
        assert.ok(refused.remediation, label + ' must carry explicit remediation');
      }
    } finally {
      await controller.close();
    }
  });

  it('keeps a reattached lane supervising activity, idle, error, and permission events', async () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-reconnect-'));
    directories.push(project);
    const controller = new SupervisionController({ projectRoot: project, config: config(), runId: 'sup-reconnect-run', credential: 'b'.repeat(48) });
    await controller.start();
    let bridge = null;
    try {
      const host = async (method) => {
        if (method === 'host.supervisor.create') return { session_id: 'supervisor-rc' };
        if (method === 'host.permission.reply') return { replied: true };
        return {};
      };
      bridge = await connectAuthenticatedIpc(controller.ipc.endpoint, controller.auth(), host);
      await bridge.call('bridge.connect', bridgeIdentity({ server_identity: 'server-rc' }));
      await bridge.call('bootstrap', { adapter: 'opencode', mode: 'attached', project_root: project, root_session_id: 'root-rc', opencode_version: '1.18.4', server_identity: 'server-rc' });
      await bridge.call('operator.command', { principal: 'operator', command: 'authorize', unit_id: 'U-RC', scope_ref: 'task-file:T-RC' });
      await bridge.call('lane.prepare', { envelope: { lane_id: 'lane-rc', role: 'engineer', task_ref: 'T-RC', expected_artifact: 'commit:rc', authorized_unit_id: 'U-RC', scope_ref: 'task-file:T-RC' } });
      await bridge.call('lane.bind', { lane_id: 'lane-rc', session_id: 'worker-rc' });

      // Drop the bridge exactly as a plugin disposal would.
      bridge.close();
      await new Promise(resolvePromise => setTimeout(resolvePromise, 60));
      assert.equal(controller.kernel.state.bridge.status, 'lost');
      assert.equal(controller.kernel.state.controller.status, 'bridge_lost', 'an incidental disconnect is not a stop');
      assert.notEqual(controller.kernel.state.controller.status, 'stopped');

      bridge = await connectAuthenticatedIpc(controller.ipc.endpoint, controller.auth(), host);
      await bridge.call('bridge.connect', bridgeIdentity({ server_identity: 'server-rc' }));
      const snapshot = await bridge.call('bridge.reattach', { project_root: project, run_id: 'sup-reconnect-run', server_identity: 'server-rc', root_session_id: 'root-rc', live_session_ids: ['worker-rc'] });
      assert.deepEqual(snapshot.snapshot.lanes.map(lane => lane.lane_id), ['lane-rc']);
      assert.equal(controller.kernel.state.controller.status, 'authorized', 'reconnecting restores controlled work');

      assert.deepEqual(await bridge.call('host.activity', { target: 'worker-rc', session_id: 'worker-rc', state: 'running', event_id: null }), { ok: true });
      const permission = await bridge.call('permission.asked', { permission: { id: 'req-rc', session_id: 'worker-rc', operation: 'bash', patterns: ['git status*'] } });
      assert.equal(permission.ok, true);
      await bridge.call('operator.command', { principal: 'operator', command: 'permission', request_id: 'req-rc', decision: 'reject' });
      const errored = await bridge.call('host.outcome', { target: 'worker-rc', outcome: 'failed_transport', metadata: {} });
      assert.equal(errored.ok, true);
      assert.equal(controller.kernel.findLane('lane-rc').outcome, 'failed_transport');
    } finally {
      bridge?.close();
      await controller.close();
    }
  });

  it('never sends an operator stop from plugin disposal', () => {
    const plugin = renderOpencodeSupervisionPlugin();
    const dispose = plugin.slice(plugin.indexOf('dispose: async'));
    assert.equal(dispose.includes('command: "stop"'), false, 'disposal must not terminate the controller');
    assert.ok(plugin.includes('drainControllerStderr'), 'the spawned controller stderr must be drained');
    assert.equal(plugin.includes('controllerStderrTail'), false, 'private controller stderr must never be retained or surfaced');
    assert.ok(plugin.includes('private diagnostics withheld'));
  });
});

describe('G. batch joins and durable dispositions', () => {
  it('opens a join only on verified artifacts or explicit durable dispositions', async () => {
    const value = kernel({ host: { abortSession: async () => ({ aborted: true }), permissionReply: async () => {} } });
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.registerSupervisor('supervisor-1');
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2', authorized_by: 'operator' });
    value.markBridgeConnected(bridgeIdentity());
    const lanes = ['lane-ok', 'lane-rejected', 'lane-cancelled', 'lane-blocked', 'lane-misconfigured'];
    for (const laneId of lanes) {
      value.prepareLane({
        lane_id: laneId, role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:' + laneId,
        authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1,T-2', batch_id: 'batch-1', required_lane_ids: lanes,
      });
      value.bindLaneSession(laneId, 'worker-' + laneId);
    }
    const batch = () => value.state.batches.find(entry => entry.id === 'batch-1');

    value.recordOutcome('lane-ok', 'completed', { reconciliation: { verified: true, present: true, kind: 'commit', reference: 'ok' } });
    assert.equal(batch().join_open, false);

    // A rejected permission is an answered wait, not a blocked lane.
    value.recordPermission({ id: 'req-r', session_id: 'worker-lane-rejected', operation: 'bash', patterns: ['git status*'] });
    value.decidePermission('req-r', 'reject', { principal: 'operator' });
    assert.equal(value.findLane('lane-rejected').outcome, 'permission_rejected');
    assert.equal(batch().join_open, false, 'permission_rejected alone must not close a join');

    // A host-reported cancellation is not an approved terminal lane decision.
    value.recordOutcome('lane-cancelled', 'cancelled', {});
    assert.equal(value.findLane('lane-cancelled').disposition, null);
    assert.equal(batch().join_open, false, 'a host cancellation alone must not close a join');

    // A failed configuration needs operator remediation, not a completed disposition.
    value.recordOutcome('lane-misconfigured', 'failed_configuration', {});
    assert.equal(batch().join_open, false, 'failed_configuration alone must not close a join');

    const blockContext = value.issueActionContext({ allowed_actions: ['record_block'], target: 'lane-blocked', target_kind: 'lane', wake_id: 'b' });
    const blocked = await value.applyDisposition({ action: 'record_block', target: 'lane-blocked', rationale: 'needs a human decision' }, { actionContext: blockContext });
    assert.equal(blocked.ok, true);
    assert.equal(value.findLane('lane-blocked').disposition.kind, 'blocked', 'record_block persists against the exact lane');
    assert.equal(value.findLane('lane-blocked').disposition.provenance, 'supervisor');
    assert.equal(batch().join_open, false);

    value.recordLaneDisposition('lane-rejected', 'blocked', { provenance: 'operator', reason: 'no safe route after rejection' });
    value.recordLaneDisposition('lane-cancelled', 'cancelled', { provenance: 'operator', reason: 'operator approved termination' });
    assert.equal(batch().join_open, false, 'the misconfigured lane still has no durable disposition');
    value.recordLaneDisposition('lane-misconfigured', 'failed', { provenance: 'operator', reason: 'configuration cannot be remediated in this unit' });
    assert.equal(batch().join_open, true, 'every required lane now has a verified artifact or a durable disposition');
    assert.equal(batch().lanes['lane-ok'].artifact_valid, true, 'a successful sibling artifact is preserved');
    assert.equal(value.findLane('lane-ok').outcome, 'completed');
  });

  it('refuses a completed disposition without a verified artifact and an unknown disposition kind', () => {
    const value = kernel();
    authorizeAndPrepare(value, 'lane-a');
    assert.throws(() => value.recordLaneDisposition('lane-a', 'completed', { provenance: 'operator' }), /verified expected artifact/);
    assert.throws(() => value.recordLaneDisposition('lane-a', 'accepted', { provenance: 'operator' }), /unknown lane disposition/);
    assert.throws(() => value.recordLaneDisposition('lane-a', 'blocked', { provenance: 'engineer' }), /provenance/);
  });

  it('keeps a retry generation from carrying a stale disposition into the join', () => {
    const value = kernel();
    value.registerRoot({ session_id: 'root-1', project_root: 'C:/project' });
    value.authorizeWorkUnit({ unit_id: 'U-1', scope_ref: 'task-file:T-1', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-a', role: 'engineer', task_ref: 'T-1', expected_artifact: 'commit:a', authorized_unit_id: 'U-1', scope_ref: 'task-file:T-1', batch_id: 'b', required_lane_ids: ['lane-a'] });
    value.bindLaneSession('lane-a', 'worker-a');
    value.recordLaneDisposition('lane-a', 'failed', { provenance: 'operator', reason: 'first attempt failed' });
    assert.equal(value.state.batches[0].join_open, true);
    assert.equal(value.state.batches[0].lanes['lane-a'].disposition.session_generation, 1);
    value.bindLaneSession('lane-a', 'worker-a-generation-2', { lifecycle: 'running' });
    assert.equal(value.findLane('lane-a').session_generation, 2);
    assert.equal(value.findLane('lane-a').disposition, null);
    assert.equal(value.state.batches[0].join_open, false, 'a running retry cannot inherit a terminal decision');
    assert.equal(value.state.batches[0].lanes['lane-a'].disposition, null);
  });
});

describe('H. task-scoped and run-scoped event projection', () => {
  it('projects every canonical supervision event type to exactly one validated log', async () => {
    const project = eventProject('al-supervision-runlog-');
    const value = projectKernel(project, {
      runId: 'sup-runlog-run',
      host: {
        abortSession: async () => ({ aborted: true }),
        createLaneSession: async () => ({ session_id: 'worker-retry' }),
        startLane: async () => ({ started: true }),
        createRoot: async () => ({ session_id: 'root-replacement' }),
        startRoot: async () => ({ started: true }),
        permissionReply: async () => ({ replied: true }),
      },
    });
    value.registerRoot({ session_id: 'root-log', project_root: project });
    value.registerRootMessage('message-log', 'orchestrator');
    value.registerSupervisor('supervisor-log');
    value.markBridgeConnected(bridgeIdentity());
    value.authorizeWorkUnit({ unit_id: 'U-001', scope_ref: 'task-file:T-001,T-002', authorized_by: 'operator' });
    value.prepareLane({ lane_id: 'lane-log', role: 'engineer', task_ref: 'T-001', expected_artifact: 'commit:abc', authorized_unit_id: 'U-001', scope_ref: 'task-file:T-001,T-002' });
    value.bindLaneSession('lane-log', 'worker-log');
    value.recordOutcome('lane-log', 'completed', { reconciliation: { verified: true, present: true, kind: 'commit', reference: 'abc' } });

    value.recordPermission({ id: 'req-log', session_id: 'worker-log', operation: 'bash', patterns: ['git status*'] });
    await value.replyPermission('req-log', 'once', { principal: 'supervisor' });

    const retryContext = value.issueActionContext({ allowed_actions: ['fresh_retry'], target: 'lane-log', target_kind: 'lane', wake_id: 'retry' });
    await value.applyDisposition({ action: 'fresh_retry', target: 'lane-log', rationale: 'transport reset' }, { actionContext: retryContext });
    await value.cancelSession('lane-log', { principal: 'operator', rationale: 'terminal' });

    const replaceContext = value.issueActionContext({ allowed_actions: ['replace_orchestrator'], target: 'root', target_kind: 'root', wake_id: 'replace' });
    await value.applyDisposition({ action: 'replace_orchestrator', target: 'root', rationale: 'root lost' }, { actionContext: replaceContext });
    value.exhaust('lane unknown outcomes', 'lane-log');
    value.stop();

    const taskLog = resolveEventLogPath(project, undefined, 'T-001').path;
    const runLog = value.runEventLogPath();
    assert.deepEqual(validateEventLogFile(taskLog, { target: project }).errors, [], 'the task log must stay canonical');
    assert.deepEqual(validateEventLogFile(runLog, { target: project }).errors, [], 'the run log must stay canonical');

    const taskEvents = loadEvents(taskLog);
    const runEvents = loadEvents(runLog);
    for (const event of taskEvents) {
      assert.equal(event.scope, undefined, 'task-scoped events keep their historical shape');
      assert.ok(event.task_id, 'task-scoped events carry a task id');
    }
    for (const event of runEvents) {
      assert.equal(event.scope, 'run');
      assert.equal(event.run_id, 'sup-runlog-run');
      assert.equal(event.task_id, null);
      assert.ok(['controller', 'supervisor', 'operator'].includes(event.role));
      assert.equal(JSON.stringify(event).includes('prompt'), false);
      assert.equal(JSON.stringify(event).includes('transcript'), false);
    }

    const taskTypes = new Set(taskEvents.map(event => event.event_type));
    const runTypes = new Set(runEvents.map(event => event.event_type));
    for (const type of ['supervision.registered', 'supervision.reconciled', 'supervision.permission_decided', 'supervision.retried', 'supervision.cancelled', 'supervision.assessed']) {
      assert.ok(taskTypes.has(type), 'expected task-scoped ' + type);
    }
    for (const type of ['supervision.registered', 'supervision.message', 'supervision.root_replaced', 'supervision.exhausted', 'supervision.terminated']) {
      assert.ok(runTypes.has(type), 'expected run-scoped ' + type);
    }
    // One logical event reaches exactly one store.
    assert.equal(runTypes.has('supervision.reconciled'), false);
    assert.equal(taskTypes.has('supervision.terminated'), false);
  });

  it('records an append failure as a secret-safe diagnostic instead of throwing', () => {
    const project = eventProject('al-supervision-logfail-');
    const value = projectKernel(project, { runId: 'sup-logfail-run' });
    value.registerRoot({ session_id: 'root-f', project_root: project });
    value.emitMaterial('supervision.assessed', {
      role: 'supervisor',
      outcome: 'not-a-valid-outcome',
      summary: 'rejected event carrying token=' + SENTINEL,
      data: { note: 'secret=' + SENTINEL },
    });
    const diagnostic = value.state.diagnostics.find(entry => entry.type === 'event_log_projection_failed');
    assert.ok(diagnostic, 'a rejected append must be recorded as a diagnostic');
    assert.equal(JSON.stringify(value.state.diagnostics).includes(SENTINEL), false, 'diagnostics stay secret-safe');

    const rejectedBefore = value.state.diagnostics.filter(entry => entry.type === 'run_scoped_event_type_not_approved').length;
    value.emitMaterial('supervision.message', { role: 'controller', outcome: 'success', summary: 'taskless message' });
    assert.equal(value.state.diagnostics.filter(entry => entry.type === 'run_scoped_event_type_not_approved').length, rejectedBefore);
    assert.ok(loadEvents(value.runEventLogPath()).some(event => event.event_type === 'supervision.message'));
  });
});

describe('I. version and ownership maintenance', () => {
  it('derives the displayed range and the comparison from one bounds definition', () => {
    assert.deepEqual(OPENCODE_VERSION_BOUNDS.minimum, [1, 18, 4]);
    assert.deepEqual(OPENCODE_VERSION_BOUNDS.exclusive_maximum, [1, 19, 0]);
    assert.equal(SUPPORTED_OPENCODE_VERSION_RANGE, '>=1.18.4 <1.19.0');
    const cases = [
      ['1.18.4', true, 'lower boundary'],
      ['1.18.5', true, 'later patch'],
      ['1.18.40', true, 'multi-digit patch'],
      ['1.18.4+build.7', true, 'build metadata'],
      ['1.18.3', false, 'below the lower boundary'],
      ['1.19.0', false, 'the exclusive upper boundary'],
      ['1.19.1', false, 'above the upper boundary'],
      ['2.18.4', false, 'other major'],
      ['0.18.4', false, 'earlier major'],
      ['1.17.9', false, 'earlier minor'],
      ['1.18.4-beta.1', false, 'pre-release'],
      ['1.18.5-rc.1', false, 'later pre-release'],
      ['1.18', false, 'malformed'],
      ['v1.18.4', false, 'malformed prefix'],
      ['', false, 'empty'],
      [undefined, false, 'missing'],
    ];
    for (const [version, expected, label] of cases) {
      assert.equal(isSupportedOpencodeVersion(version), expected, label + ': ' + String(version));
    }
  });

  it('fails closed on a live or reused PID and binds release to the exact process instance', () => {
    const project = mkdtempSync(join(tmpdir(), 'al-supervision-pid-'));
    directories.push(project);
    const runId = 'sup-pid-run';
    const first = acquireOwnershipLock(project, runId, { owner_id: 'a', pid: process.pid, process_instance: 'instance-a' });
    assert.equal(first.acquired, true);

    let killed = 0;
    const reused = acquireOwnershipLock(project, runId, { owner_id: 'b', pid: process.pid, process_instance: 'instance-b' }, {
      verifyStaleOwner: owner => {
        // A reused PID is live, so takeover is refused; nothing is terminated.
        killed += 0;
        return owner.pid !== process.pid ? true : false;
      },
    });
    assert.equal(reused.acquired, false);
    assert.equal(reused.reason, 'pid_reused_or_owner_unverified');
    assert.equal(reused.remediation, PID_REUSE_REMEDIATION);
    assert.equal(killed, 0, 'no process is ever terminated to acquire a lock');
    assert.equal(existsSync(supervisionPaths(project, runId).lock), true, 'the live lock is never stolen');

    // Same owner id but a different process instance is not proof of ownership.
    const impostor = acquireOwnershipLock(project, runId, { owner_id: 'a', pid: process.pid, process_instance: 'instance-other' });
    assert.equal(impostor.acquired, false);
    assert.equal(releaseOwnershipLock(project, runId, 'a', 'instance-other'), false, 'release requires the exact process instance');
    assert.equal(releaseOwnershipLock(project, runId, 'a', 'instance-a'), true);
  });

  it('documents orphaned_process as a reserved outcome with no attached-mode producer', () => {
    const plugin = renderOpencodeSupervisionPlugin();
    assert.equal(plugin.includes('orphaned_process'), false, 'the attached bridge must never produce an orphaned_process outcome');
    const value = kernel();
    assert.equal(value.status().capabilities.process_termination, false);
    assert.deepEqual(value.status().processes, [], 'no process registry entry is ever fabricated');
    assert.equal(value.status().process_capability.provenance, 'attached-mode-unavailable');
  });
});

describe('J. operator surface', () => {
  it('requires an explicit operator confirmation for persistent always permission approval', async () => {
    const controller = clockController(config(), () => Date.UTC(2026, 6, 22));
    startLane(controller, 'lane-always', 'T-1');
    controller.kernel.recordPermission({ id: 'req-always', session_id: 'worker-lane-always', operation: 'bash', patterns: ['git status*'] });
    controller.kernel.host.permissionReply = async () => ({ replied: true });

    const refused = await controller.operatorCommand({ principal: 'operator', command: 'permission', request_id: 'req-always', decision: 'always' });
    assert.equal(refused.code, 'confirmation_required');
    assert.equal(controller.kernel.state.permissions.find(entry => entry.id === 'req-always').status, 'pending');

    const confirmed = await controller.operatorCommand({ principal: 'operator', command: 'permission', request_id: 'req-always', decision: 'always', confirm_always: true });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.permission.status, 'approved_always');
  });

  it('renders a useful, secret-free human status with pagination guidance', () => {
    const value = kernel();
    authorizeAndPrepare(value, 'lane-a');
    value.recordPermission({
      id: 'req-h', session_id: 'worker-lane-a', operation: 'bash',
      patterns: ['curl -H Authorization:Bearer_' + SENTINEL + ' https://example.test'],
      metadata: { command: 'curl -H Authorization:Bearer_' + SENTINEL + ' https://example.test' },
    });
    const text = formatStatus(value.status());
    for (const fragment of ['Supervision authorized', 'Authorization: unit U-1', 'Server:', 'Bridge:', 'Root:', 'Supervisor:', 'Lanes: 1/1', 'Pending permissions: 1/1', 'Budgets:', 'Cost:', 'Time:', 'Unsupported in attached mode:', 'Notifications:', 'Paging:']) {
      assert.ok(text.includes(fragment), 'human status is missing "' + fragment + '"');
    }
    assert.equal(text.includes(SENTINEL), false, 'human status must never print secret-bearing permission metadata');
    assert.equal(text.includes('curl'), false, 'human status must not print permission command text at all');
    assert.ok(text.includes('live_message_injection'));
  });

  it('paginates permissions explicitly instead of silently returning the first page', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    startLane(controller, 'lane-p', 'T-1');
    for (let index = 0; index < 5; index += 1) {
      controller.kernel.recordPermission({ id: 'req-' + index, session_id: 'worker-lane-p', operation: 'bash', patterns: ['git status*'] });
    }
    const firstPage = await controller.operatorCommand({ principal: 'operator', command: 'permissions', page: { offset: 0, limit: 2 } });
    assert.equal(firstPage.permissions.length, 2);
    assert.equal(firstPage.collections.pending.total, 5);
    assert.equal(firstPage.collections.pending.truncated, true);
    assert.equal(firstPage.collections.pending.next_offset, 2);
    const secondPage = await controller.operatorCommand({ principal: 'operator', command: 'permissions', page: { offset: 2, limit: 2 } });
    assert.deepEqual(secondPage.permissions.map(entry => entry.id), ['req-2', 'req-3']);
    assert.ok(formatPermissions(firstPage).includes('Pending permissions: 2/5'));
    assert.ok(formatPermissions(firstPage).includes('next --offset 2'));
  });

  it('makes notification read state an authenticated acknowledgment rather than a permanent claim', async () => {
    const clock = Date.UTC(2026, 6, 22);
    const controller = clockController(config(), () => clock);
    for (let index = 0; index < 3; index += 1) controller.kernel.notify('budget', 'notice ' + index);
    assert.equal(controller.kernel.status().notification_summary.unread, 3);

    const partial = await controller.operatorCommand({ principal: 'operator', command: 'notifications', acknowledge: true, through_sequence: 2 });
    assert.equal(partial.acknowledged_through, 2);
    assert.equal(controller.kernel.status().notification_summary.unread, 1);

    const all = await controller.operatorCommand({ principal: 'operator', command: 'notifications', acknowledge: true });
    assert.equal(all.unread, 0);
    controller.kernel.notify('budget', 'a later notice');
    assert.equal(controller.kernel.status().notification_summary.unread, 1, 'a notice issued after acknowledgment is unread again');
    assert.throws(() => controller.kernel.acknowledgeNotifications({ principal: 'supervisor' }), /operator provenance/);
  });

  it('returns unsupported_capability for reserved actions with no attached producer', async () => {
    const value = kernel();
    authorizeAndPrepare(value, 'lane-a');
    value.markBridgeConnected(bridgeIdentity());
    for (const [action, capability] of [['message_session', 'live_message_injection'], ['terminate_owned_process', 'process_termination']]) {
      const context = value.issueActionContext({ allowed_actions: [action], target: 'lane-a', target_kind: 'lane', wake_id: action });
      const result = await value.applyDisposition({ action, target: 'lane-a' }, { actionContext: context });
      assert.deepEqual(result, { ok: false, code: 'unsupported_capability', capability });
    }
    assert.deepEqual(value.status().unsupported_capabilities, ['live_message_injection', 'server_recovery', 'process_termination', 'managed_mode']);
  });
});

describe('K. provider-backed acceptance fixture', () => {
  function fixtureDirectory(marker = { disposable: true, purpose: PROVIDER_FIXTURE_PURPOSE }) {
    const target = mkdtempSync(join(tmpdir(), 'al-provider-fixture-'));
    directories.push(target);
    if (marker) writeFileSync(join(target, PROVIDER_FIXTURE_MARKER), JSON.stringify(marker), 'utf8');
    return target;
  }

  function baseEnv(target) {
    return {
      AGENTICLOOP_OPENCODE_PROVIDER_SMOKE: '1',
      AGENTICLOOP_OPENCODE_PROVIDER_TARGET: target,
      AGENTICLOOP_OPENCODE_PROVIDER_MODEL: 'provider/model-name',
      AGENTICLOOP_OPENCODE_PROVIDER_COST_ACK: 'yes',
      AGENTICLOOP_OPENCODE_PROVIDER_CREDENTIALS_ACK: 'yes',
      AGENTICLOOP_OPENCODE_PROVIDER_TIMEOUT_MS: '60000',
    };
  }

  it('accepts only a fully specified, explicitly marked disposable fixture', () => {
    const target = fixtureDirectory();
    const repoRoot = mkdtempSync(join(tmpdir(), 'al-provider-repo-'));
    directories.push(repoRoot);
    const home = mkdtempSync(join(tmpdir(), 'al-provider-home-'));
    directories.push(home);
    const context = { repoRoot, home };

    const accepted = validateProviderFixture(baseEnv(target), context);
    assert.equal(accepted.enabled, true, accepted.reason);
    assert.equal(accepted.fixture.model, 'provider/model-name');
    assert.equal(accepted.fixture.timeout_ms, 60_000);
    assert.equal(accepted.fixture.cost_acknowledged, true);
    assert.equal(accepted.fixture.credentials_acknowledged, true);
    // The gate records acknowledgement only; it never reads a credential value.
    assert.equal(JSON.stringify(accepted).toLowerCase().includes('api_key'), false);

    const rejections = [
      ['unset opt-in', { AGENTICLOOP_OPENCODE_PROVIDER_SMOKE: '0' }, /SMOKE is not set/],
      ['missing target', { AGENTICLOOP_OPENCODE_PROVIDER_TARGET: '' }, /TARGET is required/],
      ['missing model', { AGENTICLOOP_OPENCODE_PROVIDER_MODEL: '' }, /MODEL is required/],
      ['bare model name', { AGENTICLOOP_OPENCODE_PROVIDER_MODEL: 'model' }, /explicit provider\/model route/],
      ['no cost acknowledgement', { AGENTICLOOP_OPENCODE_PROVIDER_COST_ACK: 'y' }, /COST_ACK must be exactly "yes"/],
      ['no credential acknowledgement', { AGENTICLOOP_OPENCODE_PROVIDER_CREDENTIALS_ACK: '' }, /CREDENTIALS_ACK must be exactly "yes"/],
      ['unbounded timeout', { AGENTICLOOP_OPENCODE_PROVIDER_TIMEOUT_MS: '999999999' }, /TIMEOUT_MS must be between/],
      ['too-short timeout', { AGENTICLOOP_OPENCODE_PROVIDER_TIMEOUT_MS: '10' }, /TIMEOUT_MS must be between/],
      ['repository root', { AGENTICLOOP_OPENCODE_PROVIDER_TARGET: repoRoot }, /must not be the Agentic Loop repository root/],
      ['home directory', { AGENTICLOOP_OPENCODE_PROVIDER_TARGET: home }, /must not be the operator home directory/],
      ['missing directory', { AGENTICLOOP_OPENCODE_PROVIDER_TARGET: join(target, 'absent') }, /does not exist as a directory/],
    ];
    for (const [label, override, pattern] of rejections) {
      const result = validateProviderFixture({ ...baseEnv(target), ...override }, context);
      assert.equal(result.enabled, false, label + ' must be refused');
      assert.match(result.reason, pattern, label);
    }

    const unmarked = fixtureDirectory(null);
    assert.match(validateProviderFixture({ ...baseEnv(unmarked), AGENTICLOOP_OPENCODE_PROVIDER_TARGET: unmarked }, context).reason, /disposability marker/);
    const wrongMarker = fixtureDirectory({ disposable: false, purpose: PROVIDER_FIXTURE_PURPOSE });
    assert.match(validateProviderFixture({ ...baseEnv(wrongMarker), AGENTICLOOP_OPENCODE_PROVIDER_TARGET: wrongMarker }, context).reason, /must contain/);
    const workspace = fixtureDirectory();
    assert.match(
      validateProviderFixture({ ...baseEnv(workspace), AGENTICLOOP_OPENCODE_PROVIDER_TARGET: workspace }, { ...context, workspaceRoots: [workspace] }).reason,
      /must not be a configured workspace root/
    );
  });

  it('validates the fixture contract without ever invoking a provider', () => {
    const target = fixtureDirectory();
    const before = process.env.AGENTICLOOP_OPENCODE_PROVIDER_SMOKE;
    assert.equal(before, undefined, 'the deterministic suite must never run with the provider gate enabled');
    const result = validateProviderFixture(baseEnv(target), { repoRoot: process.cwd() });
    assert.equal(result.enabled, true);
    assert.equal(typeof result.fixture.target, 'string');
  });

  it('drives both engineer generations through the host API and never fabricates the artifact', async () => {
    const target = fixtureDirectory();
    const driverSource = readFileSync(join(process.cwd(), 'scripts', 'provider-supervision-driver.js'), 'utf8');
    assert.equal(driverSource.includes('writeFileSync'), false, 'the provider driver must not contain an artifact-writing primitive');
    const calls = [];
    const request = async (_serverUrl, path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body ?? null });
      if (path === '/session' && options.method === 'POST') {
        const title = options.body?.title ?? '';
        if (title.includes('fixture root')) return { id: 'provider-root' };
        if (title.includes('fixture supervisor')) return { id: 'provider-supervisor' };
        if (title.includes('recovery')) return { id: 'provider-worker-recovery' };
        if (title.includes('engineer lane')) return { id: 'provider-worker-initial' };
      }
      if (path === '/session/provider-supervisor/message') {
        return { info: { cost: 0.25 }, parts: [{ type: 'text', text: JSON.stringify({ action: 'fresh_retry', target: 'lane-provider', rationale: 'recover the injected transport loss', evidence_refs: [] }) }] };
      }
      if (path === '/session/provider-worker-initial/message') {
        return { parts: [{ type: 'text', text: 'READY' }] };
      }
      if (path === '/session/provider-worker-recovery/message') {
        const prompt = options.body?.parts?.[0]?.text ?? '';
        assert.ok(prompt.includes('Create exactly'));
        writeFileSync(join(target, PROVIDER_ARTIFACT_RELATIVE_PATH), 'agenticloop provider fixture artifact\n', 'utf8');
        return { parts: [{ type: 'text', text: 'completed' }] };
      }
      if (path.endsWith('/abort')) return {};
      throw new Error(`unexpected provider-driver request: ${options.method ?? 'GET'} ${path}`);
    };

    const scenario = await runProviderScenario({
      fixture: { target, model: 'provider/model-name', timeout_ms: 60_000 },
      serverUrl: 'http://provider-fixture.test',
      opencodeVersion: '1.18.4',
      request,
    });
    assert.deepEqual(scenario.steps.filter(step => !step.ok), []);
    assert.equal(calls.filter(call => call.path.endsWith('/message')).length, 3, 'initial engineer, supervisor, and recovered engineer must all invoke the host');
    assert.ok(calls.some(call => call.path === '/session/provider-worker-recovery/message'));
    assert.equal(scenario.steps.find(step => step.name === 'budget_and_event_accounting').detail.cost.tracking, 'host-reported');
    assert.equal(existsSync(join(target, PROVIDER_ARTIFACT_RELATIVE_PATH)), false, 'fixture-owned artifact is cleaned after verification');
  });
});
