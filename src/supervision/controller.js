import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadAgenticLoopConfig } from '../json.js';
import { SUPPORTED_OPENCODE_VERSION_RANGE, isSupportedOpencodeVersion, validateSupervisionConfig } from './config.js';
import { MINIMUM_ATTACHED_CAPABILITIES, SupervisionKernel, createInitialRuntimeState } from './kernel.js';
import { createAuthenticatedIpcServer } from './ipc.js';
import { safeText } from './redaction.js';
import {
  SUPERVISION_STATE_VERSION,
  acquireOwnershipLock,
  createRunId,
  removeCredential,
  releaseOwnershipLock,
  supervisionPaths,
  writeCredential,
  writeRunState,
} from './state.js';

const SUPERVISOR_SYSTEM_PROMPT = [
  'You are the restricted Agentic Loop supervisor.',
  'Return one compact JSON object with action, target, rationale, evidence_refs, request_id, and configured route when applicable.',
  'The supplied action_context is immutable: action, exact target, request id, route, and authorization bindings must match it exactly.',
  'Allowed actions are supplied per wake. Do not return private reasoning or transcripts.',
  'You may inspect only bounded canonical evidence references with read, glob, or grep. Do not edit, use bash, delegate tasks, ask questions, or access the web.',
].join(' ');
const OBSERVATION_TICK_MS = 60_000;
const DEFAULT_NO_PROGRESS_MS = 5 * 60_000;

function boundedText(value, limit = 1600) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function parseSupervisorResult(result) {
  if (result && typeof result === 'object' && result.action) return result;
  if (typeof result !== 'string') throw new Error('supervisor model did not return a structured disposition');
  const trimmed = result.trim();
  const candidate = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error('supervisor model response was not a structured disposition');
  }
}

function targetKind(kernel, target) {
  return kernel.findSession(target)?.kind ?? null;
}

function recoveryActions(config) {
  const actions = ['continue_observing', 'investigate', 'fresh_retry', 'cancel_session', 'request_operator', 'record_block'];
  if (config.fallback_routes.length > 0) actions.splice(3, 0, 'use_configured_fallback');
  return actions;
}

export class SupervisionController {
  constructor({
    projectRoot,
    config,
    runId = createRunId(),
    credential = randomBytes(32).toString('base64url'),
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setTicker = setInterval,
    clearTicker = clearInterval,
    fetchImpl = globalThis.fetch,
  }) {
    this.projectRoot = resolve(projectRoot);
    this.config = config;
    this.runId = runId;
    this.credential = credential;
    this.controllerId = `controller-${randomUUID()}`;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setTicker = setTicker;
    this.clearTicker = clearTicker;
    this.fetchImpl = fetchImpl;
    this.ipc = null;
    this.lock = null;
    this.wakeChain = Promise.resolve();
    this.closed = false;
    this.observationTimer = null;
    this.backoffTimers = new Map();
    this.rateLimitBackoffs = new Map();
    this.closedPromise = new Promise(resolvePromise => { this.resolveClosed = resolvePromise; });
    this.kernel = new SupervisionKernel({
      state: createInitialRuntimeState({
        runId,
        controllerId: this.controllerId,
        projectRoot: this.projectRoot,
        config: { ...config, opencode_version_range: SUPPORTED_OPENCODE_VERSION_RANGE },
        now,
      }),
      config,
      now,
      projectRoot: this.projectRoot,
      permissionScopeKey: credential,
      persist: state => writeRunState(this.projectRoot, state),
      host: {
        abortSession: sessionId => this.hostCall('host.session.abort', { session_id: sessionId }),
        permissionReply: permission => this.hostCall('host.permission.reply', { permission }),
        createLaneSession: (lane, handoff, operationId) => this.hostCall('host.lane.create', { lane, handoff, operation_id: operationId }),
        startLane: (lane, handoff, operationId) => this.hostCall('host.lane.start', { lane, handoff, operation_id: operationId }),
        createRoot: (root, handoff, operationId) => this.hostCall('host.root.create', { root, handoff, operation_id: operationId }),
        startRoot: (root, handoff, operationId) => this.hostCall('host.root.start', { root, handoff, operation_id: operationId }),
        reconcile: handoff => this.hostCall('host.reconcile', { handoff }),
        notify: notification => this.hostCall('host.notification', { notification }),
      },
    });
  }

  async start() {
    this.processInstance = randomUUID();
    this.lock = acquireOwnershipLock(this.projectRoot, this.runId, {
      owner_id: this.controllerId,
      pid: process.pid,
      process_instance: this.processInstance,
    }, {
      verifyStaleOwner: owner => {
        if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (error) {
          return error?.code === 'ESRCH';
        }
      },
    });
    if (!this.lock.acquired) throw new Error(`supervision controller ownership is unavailable: ${this.lock.reason}${this.lock.remediation ? ` -- ${this.lock.remediation}` : ""}`);
    try {
      writeCredential(this.projectRoot, this.runId, this.credential);
      writeRunState(this.projectRoot, this.kernel.state);
      this.ipc = await createAuthenticatedIpcServer({
        credential: this.credential,
        projectRoot: this.projectRoot,
        runId: this.runId,
        onRequest: (method, params, peer) => this.handleRequest(method, params, peer),
        onBridgeConnected: params => this.kernel.markBridgeConnected({
          server_identity: params.server_identity,
          server_url: params.server_url,
          capabilities: params.capabilities,
        }),
        onBridgeDisconnected: () => {
          if (!this.closed) {
            this.kernel.markBridgeLost();
            void this.probeAttachedServerAfterBridgeLoss();
          }
        },
      });
      this.kernel.state.controller.endpoint = this.ipc.endpoint;
      this.kernel.save();
      return this.handshake();
    } catch (error) {
      if (this.ipc) await this.ipc.close();
      removeCredential(this.projectRoot, this.runId);
      releaseOwnershipLock(this.projectRoot, this.runId, this.controllerId, this.processInstance);
      this.lock = null;
      throw error;
    }
  }

  handshake() {
    const minimumCapabilitiesProven = MINIMUM_ATTACHED_CAPABILITIES.every(name => this.kernel.state.capabilities[name] === true);
    return {
      controller_id: this.controllerId,
      run_id: this.runId,
      schema_version: SUPERVISION_STATE_VERSION,
      controller_version: this.kernel.state.controller.version,
      ownership_mode: 'attached',
      root_session_id: this.kernel.state.sessions.root?.id ?? null,
      supervisor_session_id: this.kernel.state.sessions.supervisor?.id ?? null,
      supported_capabilities: Object.entries(this.kernel.state.capabilities).filter(([, value]) => value).map(([name]) => name),
      unsupported_capabilities: Object.entries(this.kernel.state.capabilities).filter(([, value]) => !value).map(([name]) => name),
      authorization: this.kernel.state.authorization && {
        unit_id: this.kernel.state.authorization.unit_id,
        scope_ref: this.kernel.state.authorization.scope_ref,
        authorized_at: this.kernel.state.authorization.authorized_at,
      },
      minimum_capability: 'attached-live',
      minimum_capability_verdict: this.kernel.state.sessions.root && this.kernel.state.sessions.supervisor && minimumCapabilitiesProven ? 'supported' : 'pending',
    };
  }

  async probeAttachedServerAfterBridgeLoss() {
    const serverUrl = this.kernel.state.server.url;
    if (!serverUrl || typeof this.fetchImpl !== 'function') return;
    let healthUrl;
    try {
      healthUrl = new URL('/global/health', serverUrl);
      if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(healthUrl.hostname)) {
        this.kernel.diagnostic('server_health_probe_refused', { reason: 'non_loopback_server_url' });
        this.kernel.save();
        return;
      }
      const response = await this.fetchImpl(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (response?.ok) return;
      throw new Error(`OpenCode health endpoint returned ${response?.status ?? 'an unavailable response'}`);
    } catch (error) {
      if (this.closed || this.kernel.state.bridge.status === 'connected') return;
      this.kernel.markServerLost(error instanceof Error ? error.message : 'OpenCode health endpoint is unavailable');
    }
  }

  async hostCall(method, params) {
    try {
      return await this.ipc.callBridge(method, { ...params, auth: this.auth() }, 10_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenCode bridge is unavailable';
      if (/bridge is unavailable|IPC connection closed|ECONNREFUSED|socket hang up/i.test(message)) this.kernel.markBridgeLost(message);
      throw error;
    }
  }

  auth() {
    return { credential: this.credential, project_root: this.projectRoot, run_id: this.runId };
  }

  async bootstrap(params) {
    if (params.adapter !== 'opencode' || params.mode !== 'attached') throw new Error('only attached OpenCode supervision is supported');
    if (params.project_root !== this.projectRoot) throw new Error('bootstrap project binding does not match controller project');
    if (!isSupportedOpencodeVersion(params.opencode_version)) throw new Error(`unsupported OpenCode version '${params.opencode_version}'; supported range is ${SUPPORTED_OPENCODE_VERSION_RANGE}`);
    if (this.kernel.state.server.identity && params.server_identity && this.kernel.state.server.identity !== params.server_identity) {
      return { ok: false, code: 'different_server_requires_restart', remediation: 'Stop this controller and restart after human review; attached mode cannot rebind to another server.' };
    }
    if (params.server_identity) this.kernel.state.server.identity = params.server_identity;
    if (this.kernel.state.sessions.root && this.kernel.state.sessions.root.id !== params.root_session_id) {
      return {
        ok: false,
        code: 'different_root_requires_replacement',
        remediation: 'Use the registered replacement-root path or stop this controller and restart after human review.',
        registered_root_session_id: this.kernel.state.sessions.root.id,
      };
    }
    if (!this.kernel.state.sessions.root) this.kernel.registerRoot({
      session_id: params.root_session_id,
      project_root: params.project_root,
      directory: params.directory,
      worktree: params.worktree,
      agent: params.agent ?? 'orchestrator',
    });
    if (this.kernel.state.sessions.supervisor) {
      this.startObservationTimer();
      return this.handshake();
    }
    const created = await this.hostCall('host.supervisor.create', {
      model: this.config.supervisor.model,
      route: this.config.supervisor.route,
      system_prompt: SUPERVISOR_SYSTEM_PROMPT,
    });
    if (!created?.session_id) throw new Error('OpenCode did not create the required supervisor session');
    this.kernel.registerSupervisor(created.session_id);
    this.startObservationTimer();
    return this.handshake();
  }

  startObservationTimer() {
    if (this.observationTimer) return;
    this.observationTimer = this.setTicker(() => { void this.tickObservation(); }, OBSERVATION_TICK_MS);
    this.observationTimer.unref?.();
  }

  /**
   * The per-lane lease, in milliseconds. Lane preparation normalizes every
   * accepted envelope spelling into exactly this field, so two lanes in one run
   * can carry different thresholds. The observation tick stays fixed at 60s.
   */
  noProgressThreshold(session) {
    const configured = Number(session?.lease?.no_progress_ms);
    return Number.isFinite(configured) && configured > 0 ? configured : (this.config.recovery?.no_progress_minutes ?? DEFAULT_NO_PROGRESS_MS / 60_000) * 60_000;
  }

  /**
   * The durable-progress lease clock.
   *
   * Liveness and progress are separate facts. Ordinary messages, busy/session
   * updates and tool completions prove a session is alive, but they are not
   * evidence that scoped work advanced, so they must not reset the lease. Only
   * a verified artifact/task/evidence checkpoint (recorded as
   * `last_durable_progress_at`) does; otherwise the lease runs from the last
   * explicit checkpoint or from lane registration.
   */
  durableProgressAnchor(session) {
    return Date.parse(session.last_durable_progress_at ?? session.last_no_progress_checkpoint_at ?? session.registered_at);
  }

  async tickObservation() {
    if (this.closed || ['stopped', 'paused', 'bridge_lost', 'server_lost'].includes(this.kernel.state.controller.status)) return;
    this.kernel.updateTimeAccounting();
    const timing = this.kernel.state.timing;
    if (timing.absolute_age_ms >= this.config.budgets.absolute_age_minutes * 60_000 || timing.active_ms >= this.config.budgets.active_minutes * 60_000) {
      if (!this.kernel.state.time_budget_exhausted) {
        this.kernel.state.time_budget_exhausted = true;
        this.kernel.notify('budget', 'Supervision time budget exhausted; controller stopped safely', { active_minutes: Math.floor(timing.active_ms / 60_000), absolute_age_minutes: Math.floor(timing.absolute_age_ms / 60_000) });
      }
      this.kernel.stop();
      await this.close();
      return;
    }
    if (!this.kernel.state.authorization) return;
    const now = this.now();
    for (const lane of this.kernel.state.sessions.lanes) {
      if (lane.status !== 'running') continue;
      const threshold = this.noProgressThreshold(lane);
      const last = this.durableProgressAnchor(lane);
      const checkpoint = Date.parse(lane.last_no_progress_checkpoint_at ?? lane.registered_at);
      if (now - last < threshold || now - checkpoint < threshold || lane.no_progress_exhausted) continue;
      lane.last_no_progress_checkpoint_at = new Date(now).toISOString();
      if (!this.kernel.incrementBudget('lane_no_progress', lane.id)) {
        lane.no_progress_exhausted = true;
        this.kernel.exhaust('lane no-progress assessment', lane.id, { budgetName: 'lane_no_progress', budgetKey: lane.id });
        continue;
      }
      this.kernel.save();
      this.scheduleSupervisorWake({
        reason: 'A registered running lane crossed its bounded no-progress checkpoint. Inspect durable evidence and select a bounded action.',
        target: lane.id,
        allowedActions: ['continue_observing', 'investigate', 'fresh_retry', 'cancel_session', 'request_operator', 'record_block'],
      });
    }
    const root = this.kernel.state.sessions.root;
    if (root?.status === 'running') {
      const threshold = this.noProgressThreshold(root);
      const last = this.durableProgressAnchor(root);
      const checkpoint = Date.parse(root.last_no_progress_checkpoint_at ?? root.registered_at);
      if (now - last >= threshold && now - checkpoint >= threshold) {
        root.last_no_progress_checkpoint_at = new Date(now).toISOString();
        this.kernel.save();
        this.scheduleSupervisorWake({
          reason: 'The registered root crossed its bounded no-progress checkpoint. Assess its exact session and durable continuation state.',
          target: 'root',
          allowedActions: ['continue_observing', 'investigate', 'cancel_session', 'replace_orchestrator', 'request_operator', 'record_block'],
        });
      }
    }
  }

  async requestSupervisor(question, actionContext, { permissionScope = null, chargePermissionAssessment = false } = {}) {
    if (!this.kernel.state.sessions.supervisor?.id || this.kernel.state.server.status !== 'connected' || this.kernel.state.bridge.status !== 'connected' || this.kernel.state.controller.status === 'paused') return { ok: false, code: 'supervisor_model_unavailable' };
    // Cost enforcement is a pre-gate. Once a nonzero ceiling is reached the
    // provider is never invoked again for this run.
    if (this.kernel.costEnforcementExhausted()) {
      this.kernel.state.budgets.cost_exhausted = true;
      this.kernel.save();
      return { ok: false, code: 'budget_exhausted', budget: 'supervisor_cost_units' };
    }
    if (chargePermissionAssessment) {
      // Permission assessments and their wakeups are one coupled reservation.
      // Neither counter changes unless both allowances are available and the
      // controller is about to cross the host/provider boundary.
      if (!this.kernel.canIncrementBudget('permission_assessments')) {
        this.kernel.exhaust('permission assessment', actionContext.request_id, { budgetName: 'permission_assessments', budgetKey: 'run' });
        return { ok: false, code: 'budget_exhausted', budget: 'permission_assessments' };
      }
      if (!this.kernel.canIncrementBudget('supervisor_wakeups')) {
        this.kernel.exhaust('supervisor wakeup', 'supervisor', { budgetName: 'supervisor_wakeups', budgetKey: 'run' });
        return { ok: false, code: 'budget_exhausted', budget: 'supervisor_wakeups' };
      }
      this.kernel.incrementBudget('permission_assessments');
      this.kernel.incrementBudget('supervisor_wakeups');
    } else if (!this.kernel.incrementBudget('supervisor_wakeups')) {
      this.kernel.exhaust('supervisor wakeup', 'supervisor');
      return { ok: false, code: 'budget_exhausted', budget: 'supervisor_wakeups' };
    }
    this.kernel.save();
    let result;
    try {
      result = await this.hostCall('host.supervisor.assess', {
        session_id: this.kernel.state.sessions.supervisor.id,
        question: safeText(question, 1600),
        allowed_actions: actionContext.allowed_actions,
        action_context: actionContext,
        // The model receives the bounded model-safe view, not the full operator
        // status surface, and never any unredacted host string.
        state: this.kernel.modelView(),
        // Assess-tier permission scope travels in its own request-bound field,
        // never interpolated into the free-form question. It is explicit
        // provider egress: keeping it out of durable state does not mean the
        // provider cannot retain it.
        ...(permissionScope ? { permission_scope: permissionScope } : {}),
      });
    } catch {
      return { ok: false, code: 'supervisor_model_unavailable' };
    }
    if (result?.available === false) return { ok: false, code: 'supervisor_model_unavailable' };
    const cost = this.kernel.recordSupervisorCost(result?.usage);
    if (cost.supported && !cost.allowed) return this.kernel.exhaust('supervisor cost', 'supervisor');
    const disposition = parseSupervisorResult(result?.disposition ?? result);
    return { ok: true, disposition, usage: cost };
  }

  scheduleSupervisorWake({ reason, target, requestId = null, allowedActions, allowedRoutes = [], investigationDepth = 0, withPermissionScope = false, chargePermissionAssessment = false }) {
    if (this.closed || !this.kernel.state.sessions.supervisor || this.kernel.state.server.status !== 'connected') return;
    this.wakeChain = this.wakeChain.then(async () => {
      if (this.closed || ['stopped', 'paused', 'bridge_lost', 'server_lost'].includes(this.kernel.state.controller.status)) return;
      const kind = targetKind(this.kernel, target);
      if (!kind) return;
      let actionContext;
      try {
        actionContext = this.kernel.issueActionContext({
          allowed_actions: allowedActions,
          target,
          target_kind: kind,
          request_id: requestId,
          allowed_routes: allowedRoutes,
          wake_id: randomUUID(),
          investigation_depth: investigationDepth,
        });
      } catch (error) {
        this.kernel.diagnostic('action_context_issue_failed', { target, error: error.message });
        this.kernel.save();
        return;
      }
      // The scope is read immediately before the provider call and revalidated
      // against the exact request, authorization generation, and session
      // generation. A missing, stale, or evicted entry routes to the operator
      // instead of assessing a request the supervisor cannot actually see.
      let permissionScope = null;
      if (withPermissionScope && requestId) {
        permissionScope = this.kernel.transientPermissionScope(requestId);
        if (!permissionScope) {
          this.kernel.notify('operator_action', 'Permission scope was unavailable for assessment; the exact request remains pending for the operator', { request_id: requestId });
          this.kernel.save();
          return;
        }
      }
      const assessment = await this.requestSupervisor(`${reason}\nTarget: ${target}${requestId ? `\nPermission request: ${requestId}` : ''}`, actionContext, { permissionScope, chargePermissionAssessment });
      if (!assessment.ok) {
        // A failed assessment ends this request's transient scope; a later
        // attempt registers a fresh one or routes to the operator.
        if (requestId) this.kernel.clearPermissionMemory({ requestId });
        if (requestId && assessment.code === 'budget_exhausted') {
          this.kernel.notify('operator_action', 'Permission assessment could not begin within the remaining budget; the exact request remains pending for the operator', { request_id: requestId, budget: assessment.budget });
          this.kernel.save();
        } else if (assessment.code !== 'budget_exhausted') {
          this.kernel.notify('capability_degraded', 'Supervisor model wakeup was unavailable', { target, code: assessment.code });
          this.kernel.save();
        }
        return;
      }
      const result = await this.kernel.applyDisposition(assessment.disposition, { actionContext });
      if (!result.ok) {
        this.kernel.notify('operator_action', 'Supervisor disposition could not be executed safely', { target, action: assessment.disposition.action, code: result.code, reason: result.reason });
        this.kernel.save();
        return;
      }
      // An autonomous `investigate` may request one bounded follow-up. Depth is
      // carried on the action context, so the chain terminates without a
      // controller-lifetime map that could grow without bound.
      if (result.action === 'investigate' && result.follow_up_allowed) {
        this.scheduleSupervisorWake({
          reason: 'A prior bounded investigation requested one follow-up assessment. Return a terminal, recovery, or operator action.',
          target,
          requestId,
          allowedActions,
          allowedRoutes,
          investigationDepth: (result.investigation_depth ?? investigationDepth) + 1,
          withPermissionScope,
          chargePermissionAssessment,
        });
      }
    }).catch(error => {
      if (!this.closed) {
        this.kernel.notify('capability_degraded', 'Supervisor wakeup processing failed', { target, error: error?.message });
        this.kernel.save();
      }
    });
  }

  backoffKey(session) {
    return `${session.kind}:${session.value.id}:${session.value.session_generation ?? 0}`;
  }

  /**
   * Defer the whole reassessment of a rate-limited route until its bounded
   * deadline.
   *
   * The chosen behaviour is "defer the full assessment": nothing is assessed
   * before the deadline, so the delayed route can never be freshly retried
   * early. The record is generation-bound, so a replacement session, a changed
   * authorization, pause/stop, bridge/server loss, or an operator action
   * invalidates it. Exactly one wake fires on expiry.
   *
   * @returns {boolean} true when a delayed wake now owns this target, so the
   * caller must not schedule its ordinary recovery assessment.
   */
  scheduleRateLimitBackoff(session, metadata) {
    const requested = Number(metadata.retry_after_ms ?? metadata.retry_after ?? 0);
    const maximum = (this.config.recovery?.max_rate_limit_delay_minutes ?? 15) * 60_000;
    const delay = Math.max(0, Math.min(maximum, Number.isFinite(requested) ? requested : 0));
    if (!delay || this.kernel.state.controller.status !== 'authorized') return false;
    const key = this.backoffKey(session);
    this.cancelBackoff(key);
    const remainingAbsolute = this.config.budgets.absolute_age_minutes * 60_000 - this.kernel.state.timing.absolute_age_ms;
    const remainingActive = this.config.budgets.active_minutes * 60_000 - this.kernel.state.timing.active_ms;
    if (delay > Math.min(remainingAbsolute, remainingActive)) {
      // A delay that cannot fit in the remaining budget routes to the operator
      // instead of scheduling a wake that could never legitimately fire.
      this.kernel.notify('operator_action', 'Rate-limit retry delay exceeds remaining time budget', { target: session.value.id, delay_ms: delay });
      this.kernel.save();
      return true;
    }
    const record = {
      key,
      target: session.kind === 'lane' ? session.value.id : 'root',
      target_kind: session.kind,
      session_id: session.value.session_id ?? session.value.id,
      session_generation: session.value.session_generation ?? 0,
      authorization_generation: this.kernel.state.authorization?.generation ?? null,
      deadline_at: new Date(this.now() + delay).toISOString(),
      delay_ms: delay,
    };
    const timer = this.setTimer(() => {
      this.backoffTimers.delete(key);
      this.rateLimitBackoffs.delete(key);
      if (!this.backoffRecordIsCurrent(record)) return;
      this.scheduleSupervisorWake({
        reason: 'A bounded host rate-limit delay elapsed. Reassess the exact registered lane.',
        target: record.target,
        allowedActions: record.target_kind === 'lane' ? recoveryActions(this.config) : ['continue_observing', 'investigate', 'request_operator'],
        allowedRoutes: record.target_kind === 'lane' ? this.config.fallback_routes.map(route => route.model) : [],
      });
    }, delay);
    timer.unref?.();
    this.backoffTimers.set(key, timer);
    this.rateLimitBackoffs.set(key, record);
    this.kernel.state.rate_limit_backoffs = [...this.rateLimitBackoffs.values()];
    this.kernel.save();
    return true;
  }

  /** A delayed wake fires only when nothing material changed while it waited. */
  backoffRecordIsCurrent(record) {
    if (this.closed) return false;
    if (this.kernel.state.controller.status !== 'authorized') return false;
    if (this.kernel.state.server.status !== 'connected' || this.kernel.state.bridge.status !== 'connected') return false;
    if ((this.kernel.state.authorization?.generation ?? null) !== record.authorization_generation) return false;
    const session = this.kernel.findSession(record.target);
    if (!session || session.kind !== record.target_kind) return false;
    if ((session.value.session_generation ?? 0) !== record.session_generation) return false;
    return true;
  }

  cancelBackoff(key = null) {
    const entries = key ? [[key, this.backoffTimers.get(key)]] : [...this.backoffTimers.entries()];
    for (const [entryKey, timer] of entries) {
      this.rateLimitBackoffs.delete(entryKey);
      if (!timer) continue;
      this.clearTimer(timer);
      this.backoffTimers.delete(entryKey);
    }
    this.kernel.state.rate_limit_backoffs = [...this.rateLimitBackoffs.values()];
  }

  async assessOperator({ question, target, allowedActions, requestId = null, allowedRoutes = [], investigationDepth = 0 }) {
    const kind = targetKind(this.kernel, target);
    if (!kind) return { ok: false, code: 'unregistered_target' };
    const actionContext = this.kernel.issueActionContext({ allowed_actions: allowedActions, target, target_kind: kind, request_id: requestId, allowed_routes: allowedRoutes, wake_id: `operator-${randomUUID()}`, investigation_depth: investigationDepth });
    const assessment = await this.requestSupervisor(question, actionContext);
    // An unavailable or budget-refused assessment never began, so it must not
    // consume an investigation step.
    if (!assessment.ok) return assessment;
    const applied = await this.kernel.applyDisposition(assessment.disposition, { actionContext });
    return { ...applied, disposition: assessment.disposition };
  }

  /**
   * Legacy (version 1) permission handling: every newly registered request
   * consumes one assessment allowance and wakes the supervisor, whatever the
   * operator may ultimately have to answer.
   */
  async assessRegisteredPermission(permission) {
    const eligible = permission.authority === 'supervisor-eligible' && Boolean(this.kernel.state.authorization);
    if (!this.kernel.incrementBudget('permission_assessments')) {
      this.kernel.exhaust('permission assessment', permission.id, { budgetName: 'permission_assessments', budgetKey: 'run' });
      this.kernel.notify('operator_action', 'Permission assessment budget exhausted; the exact request remains pending for the operator', { request_id: permission.id, lane_id: permission.lane_id });
      this.kernel.save();
      return { ok: true, permission, assessment_scheduled: false, code: 'budget_exhausted' };
    }
    this.kernel.save();
    this.scheduleSupervisorWake({
      reason: eligible ? 'Assess the exact permission request and its consequences. Approve once only if it remains inside the configured low-impact envelope.' : 'A human-only or pre-authorization permission request is waiting. Do not approve it; escalate to the operator.',
      target: permission.lane_id ?? permission.session_id,
      requestId: permission.id,
      allowedActions: eligible ? ['continue_observing', 'investigate', 'approve_permission_once', 'reject_permission', 'request_operator'] : ['continue_observing', 'investigate', 'request_operator'],
    });
    return { ok: true, permission, assessment_scheduled: true };
  }

  /**
   * Answer one request through the exact atomic reply path without a model.
   *
   * `preview -> host reply -> durable commit` is unchanged. A failed host reply
   * leaves the request pending and notifies the operator; it never mutates the
   * durable permission record.
   */
  async replyWithoutModel(permission, decision, options) {
    try {
      const decided = await this.kernel.replyPermission(permission.id, decision, options);
      return { ok: true, permission: decided, assessment_scheduled: false, decided_by: options.principal };
    } catch (error) {
      this.kernel.notify('operator_action', 'A permission reply could not be delivered; the exact request remains pending for the operator', {
        request_id: permission.id,
        lane_id: permission.lane_id,
        decided_by: options.principal,
      });
      this.kernel.save();
      return {
        ok: true,
        permission: this.kernel.status().permissions.pending.find(entry => entry.id === permission.id) ?? permission,
        assessment_scheduled: false,
        code: 'host_reply_failed',
        message: boundedText(error?.message, 240),
      };
    }
  }

  /**
   * The three-tier router.
   *
   * Budget semantics are the point of this method: only a request that actually
   * enters `assess` and begins a provider call charges `permission_assessments`
   * and `supervisor_wakeups`. Policy, cache, human-only, pre-authorization, and
   * malformed requests charge neither.
   */
  async routeRegisteredPermission(permission) {
    const tier = permission.routing_tier;
    const replay = tier === 'human' ? null : this.kernel.lookupPermissionDecision(permission);
    if (replay) {
      return await this.replyWithoutModel(permission, replay.entry.decision, {
        principal: 'cache',
        rationale: `Replayed a bounded ${replay.entry.principal} decision for an identical in-generation request`,
        cache_context: replay.context,
        cache_entry: replay.entry,
      });
    }
    if (tier === 'policy') {
      return await this.replyWithoutModel(permission, 'once', {
        principal: 'policy',
        rationale: 'Deterministic policy tier: exact scope proven inside the project root and outside the protected set',
      });
    }
    if (tier === 'assess') {
      // A stale authorization or a supervisor that cannot be reached means no
      // assessment can begin, so no allowance is charged.
      if (!this.kernel.state.authorization || !this.kernel.state.sessions.supervisor?.id
        || this.kernel.state.server.status !== 'connected' || this.kernel.state.bridge.status !== 'connected'
        || this.kernel.state.controller.status === 'paused') {
        this.kernel.notify('operator_action', 'No supervisor assessment is available; the exact request remains pending for the operator', { request_id: permission.id, lane_id: permission.lane_id });
        this.kernel.clearPermissionMemory({ requestId: permission.id });
        this.kernel.save();
        return { ok: true, permission, assessment_scheduled: false, routing_tier: tier, code: 'supervisor_model_unavailable' };
      }
      if (!this.kernel.transientPermissionScope(permission.id)) {
        this.kernel.notify('operator_action', 'Permission scope was unavailable for assessment; the exact request remains pending for the operator', { request_id: permission.id, lane_id: permission.lane_id });
        this.kernel.save();
        return { ok: true, permission, assessment_scheduled: false, routing_tier: tier, code: 'permission_scope_unavailable' };
      }
      this.scheduleSupervisorWake({
        reason: 'Assess the exact permission request from its bounded scope. Approve once, reject, or escalate to the operator.',
        target: permission.lane_id ?? permission.session_id,
        requestId: permission.id,
        allowedActions: ['approve_permission_once', 'reject_permission', 'request_operator'],
        withPermissionScope: true,
        chargePermissionAssessment: true,
      });
      return { ok: true, permission, assessment_scheduled: true, routing_tier: tier };
    }
    // Human tier: pending for the operator, no model wake, no budget charge.
    // `recordPermission` already emitted the safe human-permission notification.
    return { ok: true, permission, assessment_scheduled: false, routing_tier: 'human' };
  }

  async operatorCommand(params) {
    if (params.principal !== 'operator') throw new Error('operator provenance is required');
    const command = params.command;
    const target = params.target;
    if (command === 'status') return { ok: true, status: this.kernel.status(params.page ?? {}) };
    if (command === 'pause') {
      this.cancelBackoff();
      this.kernel.pause();
      return { ok: true, status: this.kernel.status() };
    }
    if (command === 'resume') {
      this.kernel.resume();
      return { ok: true, status: this.kernel.status() };
    }
    if (command === 'stop') {
      this.cancelBackoff();
      this.kernel.stop();
      const result = { ok: true, status: this.kernel.status() };
      this.setTimer(() => { void this.close(); }, 25);
      return result;
    }
    if (command === 'authorize') {
      this.cancelBackoff();
      this.kernel.authorizeWorkUnit({ unit_id: params.unit_id, scope_ref: params.scope_ref, authorized_by: 'operator-cli-or-tui' });
      return { ok: true, status: this.kernel.status() };
    }
    if (command === 'permissions') {
      // Explicit pagination, never a silent first page.
      const page = params.page ?? {};
      const status = this.kernel.status({ pending_permissions: page, decided_permissions: page });
      return {
        ok: true,
        permissions: status.permissions.pending,
        decided: status.permissions.decided,
        collections: { pending: status.collections.pending_permissions, decided: status.collections.decided_permissions },
      };
    }
    if (command === 'notifications') {
      if (params.acknowledge) {
        const acknowledged = this.kernel.acknowledgeNotifications({ through_sequence: params.through_sequence ?? null, principal: 'operator' });
        return { ok: true, ...acknowledged, notifications: this.kernel.status(params.page ?? {}).notifications };
      }
      const status = this.kernel.status(params.page ?? {});
      return { ok: true, notifications: status.notifications, summary: status.notification_summary, collections: { notifications: status.collections.notifications } };
    }
    if (command === 'permission') {
      if (params.decision === 'always' && params.confirm_always !== true) {
        return {
          ok: false,
          code: 'confirmation_required',
          remediation: 'Repeat the exact operator command with --confirm-always after reviewing the native OpenCode permission scope.',
        };
      }
      const options = { principal: 'operator', rationale: boundedText(params.rationale, 300) };
      this.kernel.previewPermissionDecision(params.request_id, params.decision, options);
      try {
        const permission = await this.kernel.replyPermission(params.request_id, params.decision, options);
        return { ok: true, permission };
      } catch (error) {
        return { ok: false, code: 'server_unavailable', message: error.message };
      }
    }
    if (command === 'cancel') {
      this.kernel.assertAuthorized();
      const session = this.kernel.findSession(target);
      if (!session?.value?.id) throw new Error('cancellation requires an exact registered root or lane');
      // Operator and supervisor cancellation share one path, so a failed abort
      // is recorded durably here too instead of returning a bare transport error.
      const result = await this.kernel.cancelSession(target, { principal: 'operator', rationale: boundedText(params.rationale, 300) });
      if (!result.ok) return { ...result, status: this.kernel.status() };
      return { ok: true, ...result, status: this.kernel.status() };
    }
    if (command === 'explain_last') {
      const rootTarget = this.kernel.state.sessions.root?.id ? 'root' : null;
      if (!rootTarget || this.kernel.state.bridge.status !== 'connected') return this.kernel.state.last_disposition ? { ok: true, disposition: this.kernel.state.last_disposition, fresh_model_explanation: false } : { ok: false, code: 'supervisor_model_unavailable' };
      try {
        const actionContext = this.kernel.issueActionContext({ allowed_actions: ['continue_observing', 'investigate', 'request_operator'], target: 'root', target_kind: 'root', wake_id: `explain-${randomUUID()}` });
        const assessment = await this.requestSupervisor('Explain the last bounded operational disposition in one concise factual paragraph.', actionContext);
        if (assessment.ok) return { ok: true, disposition: assessment.disposition, fresh_model_explanation: true };
      } catch {
        // Stored structured disposition is the deliberate no-model fallback.
      }
      return this.kernel.state.last_disposition ? { ok: true, disposition: this.kernel.state.last_disposition, fresh_model_explanation: false } : { ok: false, code: 'supervisor_model_unavailable' };
    }
    if (command === 'ask' || command === 'investigate') {
      // An explicit operator investigation is one fresh bounded assessment. It
      // has no lifetime per-target cap: repeated human investigations stay
      // available across retries and new session generations, limited only by
      // the ordinary wake and cost budgets.
      const actualTarget = target ?? 'root';
      const result = await this.assessOperator({
        question: params.question ?? `Investigate ${actualTarget}`,
        target: actualTarget,
        allowedActions: ['continue_observing', 'investigate', 'request_operator', 'record_block'],
        investigationDepth: 0,
      });
      return result.ok ? { ...result, findings: result.disposition?.evidence_refs ?? [], proposed_action: result.disposition?.action } : result;
    }
    if (command === 'retry') {
      return await this.assessOperator({ question: `Assess whether lane ${target} can safely be freshly retried.`, target, allowedActions: ['fresh_retry', 'request_operator', 'record_block'] });
    }
    if (command === 'replace_orchestrator') {
      return await this.assessOperator({ question: 'Assess whether the registered root should be replaced from durable continuation state.', target: 'root', allowedActions: ['replace_orchestrator', 'request_operator', 'record_block'] });
    }
    throw new Error(`unknown supervision command '${command}'`);
  }

  async handleRequest(method, params) {
    if (method === 'bootstrap') return await this.bootstrap(params);
    if (method === 'root.message') {
      this.kernel.registerRootMessage(params.message_id, params.agent);
      return { ok: true };
    }
    if (method === 'host.activity') return this.kernel.recordActivity(params.target, params);
    if (method === 'lane.prepare') return { ok: true, lane: this.kernel.prepareLane(params.envelope) };
    if (method === 'lane.bind') {
      this.kernel.bindLaneSession(params.lane_id, params.session_id);
      return { ok: true };
    }
    if (method === 'lane.started') {
      this.kernel.markLaneStarted(params.lane_id, params.session_id);
      return { ok: true };
    }
    if (method === 'host.outcome') {
      const recorded = this.kernel.recordOutcome(params.target, params.outcome, params.metadata ?? {});
      if (!recorded.ok) return recorded;
      const session = this.kernel.findSession(params.target);
      const outcome = session?.value?.outcome ?? params.outcome;
      if (params.outcome === 'failed_rate_limit' && session) {
        // A deferred assessment owns this target until its deadline; scheduling
        // the ordinary recovery wake here would allow an immediate fresh_retry.
        if (this.scheduleRateLimitBackoff(session, params.metadata ?? {})) {
          return { ok: true, outcome, deferred: true };
        }
      }
      if (session?.kind === 'lane' && ['failed_transport', 'failed_context', 'failed_rate_limit', 'failed_quota', 'failed_configuration', 'unknown'].includes(outcome)) {
        if (outcome === 'failed_quota') {
          if (!this.config.fallback_routes.length) {
            this.kernel.notify('operator_action', 'Provider or quota capacity is unavailable without a configured fallback', { lane_id: session.value.id });
            this.kernel.save();
            return { ok: true, recoverable_stop: true };
          }
        }
        if (outcome === 'failed_configuration') {
          this.kernel.notify('operator_action', 'Lane configuration requires operator remediation', { lane_id: session.value.id });
          this.kernel.save();
          return { ok: true, recoverable_stop: true };
        }
        // Once an unknown-outcome or no-artifact allowance is spent for this
        // generation, only terminal or escalation actions remain. Scheduling an
        // ordinary recovery wake here would restart the retry churn the budget
        // exists to stop.
        const exhausted = recorded.recovery_allowed === false;
        this.scheduleSupervisorWake({
          reason: exhausted
            ? `A registered lane returned outcome ${outcome} after its recovery allowance was exhausted. Select only a terminal or operator action.`
            : `A registered lane returned outcome ${outcome}. Reconcile durable evidence and select a bounded recovery or operator action.`,
          target: session.value.id,
          allowedActions: exhausted
            ? ['request_operator', 'record_block', 'cancel_session']
            : recoveryActions(this.config),
          allowedRoutes: exhausted ? [] : this.config.fallback_routes.map(route => route.model),
        });
      } else if (session?.kind === 'root' && ['failed_transport', 'failed_context', 'failed_configuration', 'unknown'].includes(outcome)) {
        this.scheduleSupervisorWake({ reason: `The registered root returned outcome ${outcome}. Assess whether it should be replaced from durable state.`, target: 'root', allowedActions: ['continue_observing', 'investigate', 'replace_orchestrator', 'request_operator', 'record_block'] });
      }
      return { ok: true, outcome, recovery_allowed: recorded.recovery_allowed !== false };
    }
    if (method === 'permission.asked') {
      const duplicate = this.kernel.state.permissions.some(entry => entry.id === params.permission?.id);
      const permission = this.kernel.recordPermission(params.permission);
      // A duplicate host event answers from the existing record. It never
      // charges a budget, schedules another action, or replaces an immutable
      // scope.
      if (duplicate) return { ok: true, permission, duplicate: true };
      return this.kernel.permissionRouting.router_active
        ? await this.routeRegisteredPermission(permission)
        : await this.assessRegisteredPermission(permission);
    }
    if (method === 'supervisor.failed') {
      if (params.session_id !== this.kernel.state.sessions.supervisor?.id) throw new Error('supervisor failure does not match the registered supervisor session');
      if (!this.kernel.incrementBudget('supervisor_replacements')) return this.kernel.exhaust('supervisor replacement', 'supervisor');
      this.kernel.save();
      let created;
      try {
        created = await this.hostCall('host.supervisor.create', { model: this.config.supervisor.model, route: this.config.supervisor.route, system_prompt: SUPERVISOR_SYSTEM_PROMPT });
      } catch (error) {
        this.kernel.notify('operator_action', 'Supervisor replacement failed; operator action is required', { session_id: params.session_id, error: error instanceof Error ? error.message : 'unknown supervisor replacement failure' });
        this.kernel.save();
        return { ok: false, code: 'supervisor_model_unavailable' };
      }
      if (!created?.session_id) throw new Error('OpenCode did not create a replacement supervisor session');
      this.kernel.registerSupervisor(created.session_id);
      return { ok: true, session_id: created.session_id };
    }
    if (method === 'bridge.reattach') {
      // Reattachment is allowed only after exact binding. A different project,
      // run, server, or root fails closed with explicit remediation instead of
      // silently adopting the reconnecting bridge.
      if (params.project_root && params.project_root !== this.projectRoot) {
        return { ok: false, code: 'different_project_requires_restart', remediation: 'Start a controller in the exact project this bridge serves.' };
      }
      if (params.run_id && params.run_id !== this.runId) {
        return { ok: false, code: 'different_run_requires_restart', remediation: 'Reattach with the exact run credential this controller issued, or stop and restart after human review.' };
      }
      if (this.kernel.state.server.identity && params.server_identity && this.kernel.state.server.identity !== params.server_identity) {
        return { ok: false, code: 'different_server_requires_restart', remediation: 'Attached mode cannot rebind to another OpenCode server; stop this controller and restart after human review.' };
      }
      if (this.kernel.state.sessions.root && params.root_session_id && this.kernel.state.sessions.root.id !== params.root_session_id) {
        return {
          ok: false,
          code: 'different_root_requires_replacement',
          remediation: 'Use the registered replacement-root path or stop this controller and restart after human review.',
          registered_root_session_id: this.kernel.state.sessions.root.id,
        };
      }
      return { ok: true, snapshot: this.kernel.reconcileReattachment({ live_session_ids: params.live_session_ids ?? [] }) };
    }
    if (method === 'server.lost') {
      this.kernel.markServerLost(boundedText(params.reason, 300));
      return { ok: true };
    }
    if (method === 'operator.command') return await this.operatorCommand(params);
    throw new Error(`unknown supervision IPC method '${method}'`);
  }

  async close() {
    if (this.closed) return;
    if (this.kernel.state.controller.status !== 'stopped') this.kernel.stop();
    this.closed = true;
    this.cancelBackoff();
    if (this.observationTimer) this.clearTicker(this.observationTimer);
    this.observationTimer = null;
    const ipc = this.ipc;
    this.ipc = null;
    if (ipc) await ipc.close();
    removeCredential(this.projectRoot, this.runId);
    releaseOwnershipLock(this.projectRoot, this.runId, this.controllerId, this.processInstance);
    this.resolveClosed?.();
  }

  waitUntilClosed() {
    return this.closedPromise;
  }
}

export function loadEnabledSupervisionConfig(projectRoot) {
  const configPath = join(projectRoot, 'agenticloop.json');
  if (!existsSync(configPath)) throw new Error('supervised activation requires agenticloop.json with supervision.enabled: true');
  const config = loadAgenticLoopConfig(configPath);
  const validation = validateSupervisionConfig(config.supervision);
  if (validation.errors.length > 0) throw new Error(`invalid supervision configuration: ${validation.errors.join('; ')}`);
  if (!validation.config.enabled) throw new Error('supervised activation is disabled; set supervision.enabled: true after installing the optional OpenCode supervision component');
  return validation.config;
}
