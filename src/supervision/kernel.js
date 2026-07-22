import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { appendEventLog, buildEvent } from '../event-logging.js';
import { loadProjectMap } from '../project-map.js';
import { normalizeLaneLease, normalizePermissionRouting } from './config.js';
import {
  PermissionDecisionCache,
  TransientPermissionScopeStore,
  buildTransientPermissionScope,
  permissionCacheContext,
} from './permission-memory.js';
import { evaluatePermissionRouting, normalizePermissionOperation } from './permission-policy.js';
import { containsSensitiveMaterial, redactSecrets, safeStructure } from './redaction.js';

export const INVOCATION_OUTCOMES = Object.freeze([
  'running',
  'completed',
  'failed_transport',
  'failed_context',
  'failed_rate_limit',
  'failed_quota',
  'waiting_permission',
  'permission_rejected',
  'cancelled',
  'failed_cancellation',
  'orphaned_process',
  'failed_configuration',
  'unknown',
]);

export const SUPERVISOR_ACTIONS = Object.freeze([
  'continue_observing',
  'investigate',
  'message_session',
  'fresh_retry',
  'use_configured_fallback',
  'cancel_session',
  'replace_orchestrator',
  'resume_work_unit',
  'approve_permission_once',
  'reject_permission',
  'terminate_owned_process',
  'request_operator',
  'record_block',
]);

const SAFE_NOTIFICATION_KINDS = new Set([
  'recovery', 'cancellation', 'route_change', 'root_replacement', 'permission_decision',
  'human_permission_wait', 'capability_degraded', 'controller_loss', 'server_loss',
  'budget', 'operator_action', 'terminal',
]);
const MODEL_ACTIONS = new Set(['investigate', 'fresh_retry', 'use_configured_fallback', 'replace_orchestrator', 'resume_work_unit']);
const AUTHORIZATION_REQUIRED_ACTIONS = new Set([
  'fresh_retry', 'use_configured_fallback', 'cancel_session', 'replace_orchestrator',
  'resume_work_unit', 'approve_permission_once', 'reject_permission', 'terminate_owned_process', 'record_block',
]);
const NON_NEGOTIABLE_HUMAN_ONLY = new Set([
  'destructive_cleanup', 'merge', 'release', 'publication', 'credentials',
  'authentication', 'external_communication', 'authorization_expansion',
  'locked_decision', 'backend_exception',
]);
const TERMINAL_OUTCOMES = new Set(['cancelled']);
const TERMINAL_LIFECYCLES = new Set(['cancelled', 'returned']);
const VERIFIED_ARTIFACT_KINDS = new Set(['file', 'path', 'commit']);
const SECRET_KEY = /(?:token|secret|password|authorization|cookie|credential|bearer|prompt|transcript|reasoning)/i;

/**
 * Durable workflow dispositions for a supervised lane. These are deliberately
 * distinct from raw host invocation outcomes: an outcome describes what the
 * host reported about one invocation, a disposition records the bounded
 * workflow decision an operator or the supervisor made about the lane.
 */
export const LANE_DISPOSITIONS = Object.freeze(['completed', 'failed', 'blocked', 'cancelled']);
const JOIN_CLOSING_DISPOSITIONS = new Set(['failed', 'blocked', 'cancelled']);

/** Supervision control-plane events that may be recorded without a task id. */
export const RUN_SCOPED_SUPERVISION_EVENT_TYPES = Object.freeze([
  'supervision.registered',
  'supervision.assessed',
  'supervision.reconciled',
  'supervision.message',
  'supervision.cancelled',
  'supervision.retried',
  'supervision.root_replaced',
  'supervision.permission_decided',
  'supervision.terminated',
  'supervision.exhausted',
]);

export const SUPERVISION_RUN_LOG_RELATIVE_DIR = join('.agenticloop', 'logs', 'supervision');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Every host-derived string that reaches public status, the supervisor model,
 * notifications, diagnostics, durable run state, or JSONL passes through here.
 * The raw text survives only as the in-memory argument to `permissionRisk`.
 */
function boundedText(value, limit = 300) {
  return redactSecrets(String(value ?? '')).slice(0, limit);
}

/** Unredacted bounded text. Only the private risk classifier may use it. */
function rawBoundedText(value, limit = 300) {
  return String(value ?? '').slice(0, limit);
}

function compactDiagnostic(value, depth = 0) {
  return safeStructure(value, { depth, keyFilter: key => SECRET_KEY.test(key) });
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizedArray(values, limit = 20) {
  return Array.isArray(values) ? values.slice(0, limit).map(value => boundedText(value, 200)) : [];
}

function rawNormalizedArray(values, limit = 20) {
  return Array.isArray(values) ? values.slice(0, limit).map(value => rawBoundedText(value, 200)) : [];
}

function exactJson(value) {
  return JSON.stringify(value);
}

function registeredSessionId(value) {
  return value?.session_id ?? value?.id ?? null;
}

function isWithinAuthorizedScope(taskRef, authorization) {
  const task = String(taskRef ?? '').trim();
  const scope = String(authorization?.scope_ref ?? '').trim();
  if (!task || !scope) return false;
  if (task === scope || task.startsWith(`${scope}/`) || task.startsWith(`${scope}#`)) return true;
  const tokens = scope.split(/[\s,:;#[\]()]+/).filter(Boolean);
  if (tokens.includes(task)) return true;
  return scope.split(':').at(-1) === task;
}

/**
 * Private, unredacted permission metadata. This value is used only as the
 * in-memory input to `permissionRisk`; it is never stored on the permission
 * record, persisted, serialized into status, or sent to the supervisor model.
 */
function collectRawScope(...candidates) {
  const values = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) values.push(...candidate);
    else if (typeof candidate === 'string' && candidate.trim()) values.push(candidate);
  }
  return values;
}

function normalizePermissionMetadata(metadata = {}) {
  const value = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    category: rawBoundedText(value.category, 80),
    command: rawBoundedText(value.command, 300),
    // Every path spelling the pinned contract can use. A target named through
    // an unrecognized key stays absent, which is incomplete scope, not an
    // implicitly empty one.
    paths: rawNormalizedArray(collectRawScope(value.paths, value.path, value.files, value.file, value.filePath, value.file_path, value.filepath), 20),
    targets: rawNormalizedArray(collectRawScope(value.targets, value.external_targets, value.target, value.url, value.urls), 20),
    maximum_effect: rawBoundedText(value.maximum_effect ?? value.max_effect, 160),
    working_directory: rawBoundedText(value.working_directory ?? value.cwd ?? value.directory, 300),
  };
}

/**
 * The only permission metadata shape that may leave the kernel.
 *
 * Arbitrary host scope is always withheld and represented by counts plus a
 * one-way fingerprint. Credential detection additionally forces the request
 * human-only: redaction patterns are defence in depth, not the serialization
 * boundary.
 */
function publicPermissionMetadata(privateMetadata, privatePatterns, privateOperation, fingerprintKey) {
  const inspected = [
    privateMetadata.category,
    privateMetadata.command,
    privateMetadata.maximum_effect,
    privateMetadata.working_directory,
    ...privateMetadata.paths,
    ...privateMetadata.targets,
    ...privatePatterns,
  ];
  const sensitive = inspected.some(entry => containsSensitiveMaterial(entry));
  const scopeFingerprint = createHmac('sha256', fingerprintKey).update(JSON.stringify({
    operation: rawBoundedText(privateOperation, 100),
    category: privateMetadata.category,
    command: privateMetadata.command,
    paths: privateMetadata.paths,
    targets: privateMetadata.targets,
    maximum_effect: privateMetadata.maximum_effect,
    working_directory: privateMetadata.working_directory,
    patterns: privatePatterns,
  })).digest('hex');
  return {
    metadata: {
      // Arbitrary host permission fields are never persisted verbatim. Regex
      // redaction is defence in depth, not proof that future credential syntax
      // is safe to serialize. Counts and a one-way fingerprint retain exact
      // identity without disclosing the scope.
      category: '',
      command: '',
      paths: [],
      targets: [],
      maximum_effect: '',
      pattern_count: privatePatterns.length,
      path_count: privateMetadata.paths.length,
      target_count: privateMetadata.targets.length,
      private_scope_withheld: true,
      sensitive_material_redacted: sensitive,
    },
    patterns: [],
    scopeFingerprint,
    sensitive,
  };
}

/**
 * One canonical public identity per operation, shared with the router.
 *
 * Every configured operation -- including `grep`, `glob`, `list`, and `search`,
 * which previously collapsed to `unknown` here -- keeps the same name in status,
 * model projection, routing, and the cache key.
 */
function publicPermissionOperation(value) {
  return normalizePermissionOperation(value);
}

function permissionRisk(request, config) {
  const operation = normalized(request.operation);
  const patterns = rawNormalizedArray(request.patterns).map(normalized);
  const metadata = request.metadata;
  const category = normalized(metadata.category ?? request.category);
  const combined = [operation, category, metadata.command, metadata.maximum_effect, ...metadata.paths, ...metadata.targets, ...patterns].join(' ');
  const configuredHumanOnly = new Set([...NON_NEGOTIABLE_HUMAN_ONLY, ...config.permissions.human_only.map(normalized)]);
  // Never copy a host-provided category into durable risk state. It participates
  // in matching below, but only canonical rule names may leave this function.
  const detected = new Set();
  const rules = [
    ['destructive_cleanup', /(?:rm\s+-rf|remove-item|git\s+clean|git\s+reset\s+--hard|delete|truncate|drop\s+)/],
    ['merge', /(?:git\s+merge|merge\s+pull\s+request|\bmerge\b)/],
    ['release', /(?:git\s+push|publish|release|deploy|gh\s+pr\s+merge)/],
    ['publication', /(?:npm\s+publish|publish|release|deploy)/],
    ['credentials', /(?:credential|secret|token|password|\.env|keychain|(?:set-)?cookie|(?:-h|--header)\s+)/],
    ['authentication', /(?:auth|login|logout|oauth)/],
    ['external_communication', /(?:send|email|slack|teams|webhook|curl\s+.*(?:-x\s+post|-d\s+|--data))/],
    ['authorization_expansion', /(?:chmod|chown|permission|grant|role\s+)/],
    ['locked_decision', /(?:locked[_ -]?decision)/],
    ['backend_exception', /(?:backend[_ -]?exception)/],
  ];
  for (const [name, matcher] of rules) if (matcher.test(combined)) detected.add(name);
  const humanOnlyCategories = [...detected].filter(name => configuredHumanOnly.has(name));
  if (humanOnlyCategories.length) return { authority: 'human-only', categories: humanOnlyCategories, consequence: 'configured high-impact or human-only operation' };
  const eligibleOperations = new Set(config.permissions.eligible_operations.map(normalized));
  if (!eligibleOperations.has(operation)) return { authority: 'human-only', categories: ['unclassified_operation'], consequence: 'operation is outside the configured once-only envelope' };
  if (operation === 'bash') {
    const command = normalized(metadata.command);
    const candidates = patterns.length ? patterns : command ? [command] : [];
    const prefixes = config.permissions.eligible_bash_patterns.map(normalized);
    const hasShellComposition = candidates.some(pattern => /(?:&&|\|\||[;|`]|\r|\n)/.test(pattern));
    const contradictory = command && patterns.length && !patterns.some(pattern => command === pattern || command.startsWith(pattern.replace(/\*$/, '')));
    if (!candidates.length || hasShellComposition || contradictory || candidates.some(pattern => !prefixes.some(prefix => pattern === prefix || pattern === `${prefix}*` || pattern.startsWith(`${prefix} `)))) {
      return { authority: 'human-only', categories: ['unclassified_bash'], consequence: 'command scope is incomplete, contradictory, or outside the configured read-only/test envelope' };
    }
  }
  return { authority: 'supervisor-eligible', categories: ['configured_low_impact'], consequence: 'request is inside the configured exact once-only envelope' };
}

function publicArtifact(lane) {
  return {
    expected_artifact: boundedText(lane.expected_artifact, 300),
    artifact_valid: lane.artifact_valid === true,
    no_artifact: lane.no_artifact === true,
    reconciliation: lane.reconciliation ? {
      verified: lane.reconciliation.verified === true,
      present: lane.reconciliation.present === true,
      kind: boundedText(lane.reconciliation.kind, 40),
      reference: boundedText(lane.reconciliation.reference, 300),
    } : null,
  };
}

function publicLane(lane) {
  return {
    id: lane.id,
    role: lane.role,
    task_ref: lane.task_ref,
    session_id: lane.session_id,
    session_generation: lane.session_generation,
    lifecycle: lane.lifecycle,
    status: lane.status,
    outcome: lane.outcome,
    disposition: lane.disposition ? { ...lane.disposition } : null,
    route: lane.route,
    lease: lane.lease ? { ...lane.lease } : null,
    artifact: publicArtifact(lane),
    last_observed_activity_at: lane.last_observed_activity_at ?? null,
    last_durable_progress_at: lane.last_durable_progress_at ?? null,
    last_outcome_at: lane.last_outcome_at ?? null,
    no_progress_exhausted: lane.no_progress_exhausted === true,
    no_artifact_exhausted: lane.no_artifact_exhausted === true,
    unknown_outcome_exhausted: lane.unknown_outcome_exhausted === true,
  };
}

/**
 * The only permission projection allowed outside the kernel. Permission records
 * already store redacted metadata; this keeps the public schema explicit so a
 * later kernel field cannot leak into status by accident.
 */
function publicPermission(permission) {
  return {
    id: permission.id,
    session_id: permission.session_id,
    session_generation: permission.session_generation,
    lane_id: permission.lane_id,
    task_ref: permission.task_ref,
    operation: permission.operation,
    patterns: [...permission.patterns],
    metadata: {
      category: permission.metadata.category,
      command: permission.metadata.command,
      paths: [...permission.metadata.paths],
      targets: [...permission.metadata.targets],
      maximum_effect: permission.metadata.maximum_effect,
      sensitive_material_redacted: permission.metadata.sensitive_material_redacted === true,
    },
    request_generation: permission.request_generation,
    status: permission.status,
    authority: permission.authority,
    risk_categories: [...permission.risk_categories],
    consequence: permission.consequence,
    created_at: permission.created_at,
    decided_at: permission.decided_at ?? null,
    decided_by: permission.decided_by ?? null,
    // Bounded routing and audit facts. The scope fingerprint, the cache key,
    // and every raw or transient scope field stay private.
    routing_tier: permission.routing_tier ?? 'legacy',
    policy_version: permission.policy_version ?? null,
    scope_complete: permission.scope_complete ?? null,
    containment: permission.containment ? {
      checked: permission.containment.checked === true,
      inside_project: permission.containment.inside_project === true,
      protected: permission.containment.protected === true,
    } : null,
    cache_origin_decision_id: permission.cache_origin_decision_id ?? null,
    cache_key_version: permission.cache_key_version ?? null,
  };
}

function collection(entries, { offset = 0, limit = 50 } = {}) {
  const safeOffset = Number.isInteger(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0;
  const safeLimit = Math.max(1, Math.min(100, Number.isInteger(Number(limit)) ? Number(limit) : 50));
  const items = entries.slice(safeOffset, safeOffset + safeLimit);
  return {
    items,
    total: entries.length,
    returned: items.length,
    offset: safeOffset,
    limit: safeLimit,
    truncated: safeOffset + items.length < entries.length,
    next_offset: safeOffset + items.length < entries.length ? safeOffset + items.length : null,
  };
}

export const ATTACHED_BRIDGE_CAPABILITIES = Object.freeze([
  'command_interception',
  'root_registration',
  'lane_registration',
  'event_stream',
  'event_reconciliation',
  'session_abort',
  'fresh_lane_invocation',
  'root_replacement',
  'exact_permission_reply',
  'tui_controller_commands',
]);

export const MINIMUM_ATTACHED_CAPABILITIES = Object.freeze([
  ...ATTACHED_BRIDGE_CAPABILITIES,
  'cli_factual_commands',
]);

const ALWAYS_UNSUPPORTED_ATTACHED_CAPABILITIES = Object.freeze([
  'live_message_injection',
  'server_recovery',
  'process_termination',
  'managed_mode',
]);

/**
 * Build the truthful attached capability surface from authenticated bridge
 * probes. Before a bridge connects, only controller-owned CLI inspection is
 * proven. Unsupported managed-mode capabilities remain false regardless of a
 * bridge claim.
 */
export function attachedCapabilities(probes = {}) {
  return {
    ...Object.fromEntries(ATTACHED_BRIDGE_CAPABILITIES.map(name => [name, probes?.[name] === true])),
    cli_factual_commands: true,
    ...Object.fromEntries(ALWAYS_UNSUPPORTED_ATTACHED_CAPABILITIES.map(name => [name, false])),
  };
}

function capabilityProvenance(capabilities, probes = {}) {
  return Object.fromEntries(Object.entries(capabilities).map(([name, supported]) => {
    if (name === 'cli_factual_commands') return [name, 'controller-proven'];
    if (ALWAYS_UNSUPPORTED_ATTACHED_CAPABILITIES.includes(name)) return [name, 'attached-mode-unavailable'];
    return [name, supported && probes?.[name] === true ? 'bridge-api-probed' : 'unproven'];
  }));
}

export function createInitialRuntimeState({ runId, controllerId, projectRoot, config, now = Date.now }) {
  const timestamp = nowIso(now);
  return {
    schema_version: 2,
    controller: {
      run_id: runId,
      controller_id: controllerId,
      project_root: projectRoot,
      adapter: 'opencode',
      mode: 'attached',
      status: 'observing',
      version: '0.2.0',
      started_at: timestamp,
      updated_at: timestamp,
    },
    authorization: null,
    capabilities: attachedCapabilities(),
    capability_provenance: capabilityProvenance(attachedCapabilities()),
    configuration: {
      opencode_version_range: config.opencode_version_range,
      configured_routes: ['maintainer', 'engineer', config.supervisor.route, ...config.fallback_routes.map(route => route.model)],
    },
    sessions: { root: null, supervisor: null, lanes: [] },
    batches: [],
    processes: [],
    permissions: [],
    // Bounded routing counters only. No key, fingerprint, or scope.
    permission_routing: {
      mode: config.permissions?.mode ?? 'eligible-once-only',
      policy_version: config.permissions?.policy?.version ?? 1,
      policy: 0,
      assess: 0,
      human: 0,
      cache_hits: 0,
      cache_misses: 0,
    },
    budgets: {
      ...config.budgets,
      cost_tracking: 'unsupported',
      used: {
        lane_infrastructure_retries: {},
        lane_no_progress: {},
        lane_no_artifact: {},
        lane_unknown_outcomes: {},
        route_fallbacks: 0,
        root_replacements: 0,
        supervisor_replacements: 0,
        supervisor_wakeups: 0,
        supervisor_cost_units: 0,
        permission_assessments: 0,
      },
    },
    timing: {
      last_accounted_at: timestamp,
      active_ms: 0,
      paused_ms: 0,
      permission_wait_ms: 0,
      human_wait_ms: 0,
      absolute_age_ms: 0,
    },
    action_contexts: [],
    diagnostics: [],
    events: [],
    notifications: [],
    notification_cursor: 0,
    notification_sequence: 0,
    budget_notifications: {},
    last_disposition: null,
    last_outcome: null,
    server: { status: 'connected', identity: null, last_reconciled_at: timestamp },
    bridge: { status: 'awaiting', last_connected_at: null, last_lost_at: null },
  };
}

/**
 * Mechanical state kernel. It records authenticated host facts and enforces the
 * immutable limits issued with a supervisor wake. Workflow acceptance remains
 * outside this advisory runtime state.
 */
export class SupervisionKernel {
  constructor({ state, config, persist = () => {}, host = {}, now = Date.now, projectRoot = null, permissionScopeKey = randomUUID(), fileSystem = undefined }) {
    this.state = state;
    this.config = config;
    this.persist = persist;
    this.host = host;
    this.now = now;
    this.projectRoot = projectRoot ?? state.controller.project_root;
    this.permissionScopeKey = permissionScopeKey;
    this.permissionRepliesInFlight = new Set();
    // The effective router is derived once. A version 1 document normalizes to
    // the legacy envelope, so nothing below can be reached by upgrade alone.
    this.permissionRouting = normalizePermissionRouting(config);
    this.permissionFileSystem = fileSystem;
    // Both stores are private, in-memory, and bounded. Neither is ever
    // serialized, projected, notified, logged, or persisted.
    this.transientPermissionScopes = new TransientPermissionScopeStore({
      maximumEntries: this.permissionRouting.transient_scope.maximum_entries,
      maximumAgeMs: this.permissionRouting.transient_scope.maximum_age_ms,
      now,
    });
    this.permissionDecisionCache = new PermissionDecisionCache({
      enabled: this.permissionRouting.decision_cache.enabled,
      maximumEntries: this.permissionRouting.decision_cache.maximum_entries,
      policyTtlMs: this.permissionRouting.decision_cache.policy_ttl_ms,
      supervisorTtlMs: this.permissionRouting.decision_cache.supervisor_ttl_ms,
      rejectionTtlMs: this.permissionRouting.decision_cache.rejection_ttl_ms,
      key: permissionScopeKey,
      now,
    });
    this.state.permission_routing = this.state.permission_routing ?? {
      mode: this.permissionRouting.mode,
      policy_version: this.permissionRouting.policy.version,
      policy: 0,
      assess: 0,
      human: 0,
      cache_hits: 0,
      cache_misses: 0,
    };
    try {
      this.eventLoggingEnabled = loadProjectMap(this.projectRoot)?.config?.event_logging === 'enabled';
    } catch {
      this.eventLoggingEnabled = false;
    }
  }

  /**
   * Charge the time that has elapsed *since the last accounting point* to the
   * state that was actually in force during it.
   *
   * Every transition calls this before it mutates state, so a five-minute
   * active period followed by a seven-minute pause records five active and
   * seven paused minutes rather than the reverse. Repeated calls at the same
   * instant add zero, so nested `save()` calls cannot double-account.
   */
  updateTimeAccounting() {
    const timing = this.state.timing;
    const now = this.now();
    const previous = Date.parse(timing.last_accounted_at);
    const elapsed = Number.isFinite(previous) ? Math.max(0, now - previous) : 0;
    const pendingPermission = this.state.permissions.some(permission => permission.status === 'pending');
    const active = this.state.controller.status === 'authorized'
      && [this.state.sessions.root, ...this.state.sessions.lanes].some(session => session?.status === 'running');
    if (this.state.controller.status === 'paused') timing.paused_ms += elapsed;
    else {
      // These are independent observations, not mutually exclusive buckets. A
      // permission wait on one lane must not erase active time accumulated by a
      // runnable sibling. Human-wait remains controller-wide and therefore
      // cannot overlap the authorized/running state.
      if (pendingPermission) timing.permission_wait_ms += elapsed;
      if (this.state.controller.status === 'waiting_operator') timing.human_wait_ms += elapsed;
      if (active) timing.active_ms += elapsed;
    }
    timing.absolute_age_ms = Math.max(0, now - Date.parse(this.state.controller.started_at));
    timing.last_accounted_at = nowIso(this.now);
  }

  /**
   * The one transition-safe entry point. Call it immediately before any change
   * that alters which timing bucket applies.
   */
  beginTransition() {
    this.updateTimeAccounting();
  }

  save() {
    this.updateTimeAccounting();
    this.state.controller.updated_at = nowIso(this.now);
    this.persist(this.state);
  }

  diagnostic(type, data = {}) {
    this.state.diagnostics.push({ id: randomUUID(), at: nowIso(this.now), type, data: compactDiagnostic(data) });
    if (this.state.diagnostics.length > 50) this.state.diagnostics.splice(0, this.state.diagnostics.length - 50);
  }

  event(type, data = {}) {
    this.state.events.push({ id: randomUUID(), at: nowIso(this.now), type, data: compactDiagnostic(data) });
    if (this.state.events.length > 100) this.state.events.splice(0, this.state.events.length - 100);
  }

  /**
   * Project one material control-plane fact.
   *
   * A lane event carries a task reference and lands in that task's canonical
   * JSONL. A root/run control-plane event (root or supervisor registration,
   * root replacement, exhaustion, termination) has no task and lands in the
   * run-scoped supervision log at
   * `.agenticloop/logs/supervision/<run-id>.jsonl`. Both use the same canonical
   * `buildEvent`/`appendEventLog` validation path, and one logical event is
   * projected to exactly one store.
   */
  emitMaterial(type, { taskRef = null, role = 'controller', outcome = 'unknown', summary, data = {}, refs = [] } = {}) {
    this.event(type, data);
    if (!this.eventLoggingEnabled) return;
    const runScoped = !taskRef;
    if (runScoped && !RUN_SCOPED_SUPERVISION_EVENT_TYPES.includes(type)) {
      this.diagnostic('run_scoped_event_type_not_approved', { type });
      return;
    }
    try {
      const event = buildEvent({
        target: this.projectRoot,
        task: taskRef,
        // Task-scoped events keep their exact historical shape: the optional
        // scope/run_id keys appear only on run-scoped control-plane events.
        ...(runScoped ? { scope: 'run', run_id: this.state.controller.run_id } : {}),
        backend: 'unknown',
        host: 'opencode',
        role,
        eventType: type,
        summary: boundedText(summary ?? type, 240),
        outcome,
        refs: normalizedArray(refs, 10),
        data: compactDiagnostic(data),
        occurredAt: nowIso(this.now),
      });
      appendEventLog({
        target: this.projectRoot,
        event,
        path: runScoped ? this.runEventLogPath() : undefined,
      });
    } catch (error) {
      // Diagnostics must stay secret-safe even when the failure text quotes the
      // rejected event; `diagnostic` redacts before it stores anything.
      this.diagnostic('event_log_projection_failed', { type, scope: runScoped ? 'run' : 'task', task_ref: taskRef, error: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  runEventLogPath() {
    return join(this.projectRoot, SUPERVISION_RUN_LOG_RELATIVE_DIR, `${this.state.controller.run_id}.jsonl`);
  }

  notify(kind, summary, data = {}) {
    if (!SAFE_NOTIFICATION_KINDS.has(kind)) throw new Error(`unsupported material notification kind '${kind}'`);
    const notification = {
      id: randomUUID(),
      at: nowIso(this.now),
      kind,
      summary: boundedText(summary, 240),
      data: compactDiagnostic(data),
      sequence: (this.state.notification_sequence ?? 0) + 1,
      read: false,
    };
    this.state.notification_sequence = notification.sequence;
    if (notification.sequence <= (this.state.notification_cursor ?? 0)) notification.read = true;
    this.state.notifications.push(notification);
    const limit = this.config.notifications.history_limit;
    if (this.state.notifications.length > limit) this.state.notifications.splice(0, this.state.notifications.length - limit);
    if (this.config.notifications.native && this.host.notify && this.state.bridge.status === 'connected') {
      Promise.resolve(this.host.notify(clone(notification))).catch(error => {
        this.diagnostic('notification_delivery_failed', { kind, error: error instanceof Error ? error.message : 'unknown error' });
      });
    }
  }

  /**
   * Authenticated acknowledgment cursor. `unread` means "issued after the last
   * operator acknowledgment", which is a claim the controller can actually
   * honour; without this the count would be permanently meaningless.
   */
  acknowledgeNotifications({ through_sequence: throughSequence = null, principal } = {}) {
    if (principal !== 'operator') throw new Error('notification acknowledgment requires operator provenance');
    const latest = this.state.notification_sequence ?? 0;
    // No explicit sequence acknowledges everything issued so far.
    const requested = throughSequence === null || throughSequence === undefined ? NaN : Number(throughSequence);
    const cursor = Number.isInteger(requested) && requested >= 0 ? Math.min(requested, latest) : latest;
    this.state.notification_cursor = Math.max(this.state.notification_cursor ?? 0, cursor);
    for (const notification of this.state.notifications) {
      if ((notification.sequence ?? 0) <= this.state.notification_cursor) notification.read = true;
    }
    this.save();
    return { acknowledged_through: this.state.notification_cursor, unread: this.unreadNotificationCount() };
  }

  unreadNotificationCount() {
    return this.state.notifications.filter(notification => !notification.read).length;
  }

  /**
   * One "approaching" notification per bounded budget at the configured
   * threshold, then one exhaustion notification. Routine observation and
   * `continue_observing` never notify.
   */
  noteBudgetPressure(name, key, used, limit) {
    if (!Number.isFinite(limit) || limit <= 0) return;
    const percent = this.config.notifications.approaching_threshold_percent;
    const marker = `${name}:${key}`;
    this.state.budget_notifications = this.state.budget_notifications ?? {};
    const recorded = this.state.budget_notifications[marker] ?? null;
    if (used >= limit) {
      if (recorded === 'exhausted') return;
      this.state.budget_notifications[marker] = 'exhausted';
      this.notify('budget', `${name} budget reached its configured limit`, { budget: name, target: key, used, limit });
      return;
    }
    if (recorded) return;
    if (used * 100 < limit * percent) return;
    this.state.budget_notifications[marker] = 'approaching';
    this.notify('budget', `${name} budget is approaching its configured limit`, { budget: name, target: key, used, limit, threshold_percent: percent });
  }

  registerRoot(root) {
    if (!root?.session_id || !root?.project_root || root.project_root !== this.state.controller.project_root) {
      throw new Error('root registration requires the exact current session and project binding');
    }
    const previous = this.state.sessions.root;
    if (previous?.id === root.session_id) return clone(previous);
    this.state.sessions.root = {
      id: root.session_id,
      message_id: root.message_id ?? null,
      agent: root.agent ?? 'orchestrator',
      directory: root.directory ?? this.state.controller.project_root,
      worktree: root.worktree ?? this.state.controller.project_root,
      session_generation: (previous?.session_generation ?? 0) + 1,
      status: 'running',
      lifecycle: 'running',
      outcome: 'running',
      registered_at: nowIso(this.now),
      last_observed_activity_at: nowIso(this.now),
      terminal_tombstone: null,
    };
    this.emitMaterial('supervision.registered', {
      role: 'controller', outcome: 'success', summary: 'Registered exact root session',
      data: { target_kind: 'root', session_id: root.session_id, generation: this.state.sessions.root.session_generation },
    });
    this.save();
    return clone(this.state.sessions.root);
  }

  registerRootMessage(messageId, agent) {
    if (!this.state.sessions.root) throw new Error('cannot bind a root message before root registration');
    this.state.sessions.root.message_id = messageId;
    if (agent) this.state.sessions.root.agent = agent;
    this.emitMaterial('supervision.message', {
      role: 'controller', outcome: 'success', summary: 'Observed a registered root message',
      data: { message_id: boundedText(messageId, 200), session_id: this.state.sessions.root.id },
    });
    this.recordActivity('root', { state: 'running', event_id: `message:${messageId}`, durable: false });
  }

  registerSupervisor(sessionId) {
    if (!sessionId) throw new Error('supervisor registration requires a session id');
    const previous = this.state.sessions.supervisor;
    this.state.sessions.supervisor = {
      id: sessionId,
      session_generation: (previous?.session_generation ?? 0) + 1,
      status: 'idle',
      lifecycle: 'running',
      registered_at: nowIso(this.now),
    };
    this.emitMaterial('supervision.registered', {
      role: 'controller', outcome: 'success', summary: 'Registered supervisor session',
      data: { target_kind: 'supervisor', session_id: sessionId, generation: this.state.sessions.supervisor.session_generation },
    });
    this.save();
  }

  authorizeWorkUnit({ unit_id, scope_ref, authorized_by }) {
    if (!unit_id || !scope_ref || !authorized_by) throw new Error('work-unit authorization requires unit id, scope reference, and operator provenance');
    this.beginTransition();
    const generation = (this.state.authorization?.generation ?? 0) + 1;
    this.state.authorization = {
      unit_id: boundedText(unit_id, 200),
      scope_ref: boundedText(scope_ref, 500),
      authorized_by: boundedText(authorized_by, 120),
      authorized_at: nowIso(this.now),
      generation,
    };
    this.state.controller.status = 'authorized';
    // A new authorization generation invalidates every remembered decision and
    // every transient scope bound to the previous one.
    this.clearPermissionMemory({ full: true });
    this.event('internal.work_unit_authorized', { unit_id, scope_ref, generation });
    this.save();
  }

  assertAuthorized({ allowPaused = false } = {}) {
    if (!this.state.authorization) throw new Error('work-unit authorization is required before controlled work');
    if (!allowPaused && this.state.controller.status === 'paused') throw new Error('supervision controller is paused');
    if (this.state.controller.status === 'bridge_lost') throw new Error('attached OpenCode bridge is unavailable');
    if (this.state.controller.status === 'server_lost') throw new Error('attached OpenCode server recovery is unsupported');
    if (this.state.controller.status === 'stopped') throw new Error('supervision controller is stopped');
  }

  prepareLane(envelope) {
    this.assertAuthorized();
    if (!envelope?.lane_id || !envelope?.role || !envelope?.task_ref || !envelope?.expected_artifact || !envelope?.authorized_unit_id || !envelope?.scope_ref) {
      throw new Error('supervised delegation requires a lane id, role, task reference, expected artifact, authorized unit, and scope binding');
    }
    if (!['maintainer', 'engineer'].includes(envelope.role)) throw new Error('only maintainer and engineer lanes may be supervised');
    if (envelope.authorized_unit_id !== this.state.authorization.unit_id) throw new Error('delegation work-unit binding does not match the authorized unit');
    if (envelope.scope_ref !== this.state.authorization.scope_ref) throw new Error('delegation scope binding does not match the authorized scope');
    if (!isWithinAuthorizedScope(envelope.task_ref, this.state.authorization)) throw new Error(`delegation task '${envelope.task_ref}' is outside the authorized scope`);
    if (this.state.sessions.lanes.some(lane => lane.id === envelope.lane_id)) throw new Error(`duplicate live lane id '${envelope.lane_id}' is not a recovery transition`);
    const route = envelope.route ?? envelope.role;
    if (!this.state.configuration.configured_routes.includes(route)) throw new Error(`delegation route '${route}' is not configured for this run`);
    const lease = normalizeLaneLease(envelope, (this.config.recovery?.no_progress_minutes ?? 5) * 60_000);
    if (lease.rejected) this.diagnostic('lane_lease_rejected', { lane_id: envelope.lane_id, ...lease.rejected });
    const lane = {
      id: envelope.lane_id,
      role: envelope.role,
      task_ref: envelope.task_ref,
      expected_artifact: boundedText(envelope.expected_artifact, 300),
      parent_session_id: envelope.parent_session_id ?? this.state.sessions.root?.id ?? null,
      session_id: null,
      session_generation: 0,
      lifecycle: 'prepared',
      status: 'prepared',
      outcome: 'unknown',
      disposition: null,
      artifact_valid: false,
      no_artifact: false,
      // The controller reads exactly this field. Units are milliseconds; the
      // fixed 60s observation tick decides when it is evaluated.
      lease: { no_progress_ms: lease.no_progress_ms, source: lease.source },
      route,
      authorization: { unit_id: envelope.authorized_unit_id, scope_ref: envelope.scope_ref, generation: this.state.authorization.generation },
      delegation: compactDiagnostic({
        delegation_mode: envelope.delegation_mode,
        host_adapter: envelope.host_adapter,
        selected_route: envelope.selected_route ?? route,
        permission_posture: envelope.permission_posture,
        owned_backend_objects: envelope.owned_backend_objects,
        branch: envelope.branch,
        worktree: envelope.worktree,
        allowed_areas: envelope.allowed_areas,
        scope: envelope.scope,
        out_of_scope: envelope.out_of_scope,
        stop_condition: envelope.stop_condition,
        lease: envelope.lease,
        checkpoints: envelope.checkpoints,
        evidence_refs: envelope.evidence_refs,
      }),
      handoff: compactDiagnostic(envelope.handoff ?? {}),
      registered_at: nowIso(this.now),
      last_observed_activity_at: null,
      last_durable_progress_at: null,
      terminal_tombstone: null,
      event_ids: [],
    };
    this.state.sessions.lanes.push(lane);
    this.registerBatchLane(lane, envelope);
    this.emitMaterial('supervision.registered', {
      taskRef: lane.task_ref, role: 'controller', outcome: 'success', summary: 'Prepared supervised lane',
      data: { lane_id: lane.id, role: lane.role, task_ref: lane.task_ref, route: lane.route },
      refs: [lane.expected_artifact],
    });
    this.save();
    return clone(lane);
  }

  registerBatchLane(lane, envelope) {
    const batchId = envelope.batch_id ?? envelope.concurrency_batch;
    if (!batchId) return;
    let batch = this.state.batches.find(entry => entry.id === batchId);
    if (!batch) {
      batch = { id: batchId, required_lane_ids: normalizedArray(envelope.required_lane_ids ?? [lane.id], 50), join_condition: boundedText(envelope.join_condition ?? 'verified_artifacts_or_explicit_terminal_disposition', 240), join_open: false, lanes: {} };
      this.state.batches.push(batch);
    }
    if (!batch.required_lane_ids.includes(lane.id)) batch.required_lane_ids.push(lane.id);
    batch.lanes[lane.id] = { session_generation: lane.session_generation, artifact_valid: false, outcome: lane.outcome, disposition: null };
  }

  /**
   * A join opens only when every required lane has a verified expected artifact
   * or an explicit durable failed/blocked/cancelled disposition.
   *
   * A raw invocation outcome is never enough: `permission_rejected` is a wait
   * that was answered, not a blocked lane; `failed_configuration` needs operator
   * remediation, not a completed disposition; and a host-reported cancellation
   * is not an operator- or supervisor-approved terminal lane decision.
   */
  updateBatchState(lane) {
    for (const batch of this.state.batches) {
      if (!batch.required_lane_ids.includes(lane.id)) continue;
      const currentDisposition = lane.disposition
        && lane.disposition.session_generation === lane.session_generation
        && lane.disposition.session_id === lane.session_id
        ? { ...lane.disposition }
        : null;
      batch.lanes[lane.id] = {
        session_generation: lane.session_generation,
        artifact_valid: lane.artifact_valid === true,
        outcome: lane.outcome,
        disposition: currentDisposition,
      };
      batch.join_open = batch.required_lane_ids.every(id => {
        const entry = batch.lanes[id];
        if (entry?.artifact_valid === true) return true;
        return JOIN_CLOSING_DISPOSITIONS.has(entry?.disposition?.kind);
      });
    }
  }

  /**
   * Record a durable workflow disposition against one exact lane. Provenance
   * and timestamp are mandatory so a join can never close on an inferred
   * decision.
   */
  recordLaneDisposition(laneId, kind, { provenance, reason = '', evidence_refs: evidenceRefs = [] } = {}) {
    if (!LANE_DISPOSITIONS.includes(kind)) throw new Error(`unknown lane disposition '${kind}'`);
    if (!['operator', 'supervisor', 'controller'].includes(provenance)) {
      throw new Error('lane disposition requires operator, supervisor, or controller provenance');
    }
    const lane = this.findLane(laneId);
    if (kind === 'completed' && lane.artifact_valid !== true) {
      throw new Error('a completed lane disposition requires a verified expected artifact');
    }
    lane.disposition = {
      kind,
      provenance,
      reason: boundedText(reason, 300),
      evidence_refs: normalizedArray(evidenceRefs, 10),
      session_id: lane.session_id,
      session_generation: lane.session_generation,
      at: nowIso(this.now),
    };
    this.updateBatchState(lane);
    this.save();
    return clone(lane.disposition);
  }

  bindLaneSession(laneId, sessionId, { lifecycle = 'bound', operationId = null } = {}) {
    const lane = this.findLane(laneId);
    if (!sessionId) throw new Error('lane session binding requires an exact session id');
    if (this.state.sessions.lanes.some(other => other.id !== lane.id && other.session_id === sessionId)) throw new Error('session id is already bound to another lane');
    lane.session_id = sessionId;
    lane.session_generation += 1;
    lane.lifecycle = lifecycle;
    lane.status = lifecycle === 'running' ? 'running' : 'starting';
    lane.outcome = lifecycle === 'running' ? 'running' : 'unknown';
    lane.recovery_operation_id = operationId;
    lane.last_observed_activity_at = nowIso(this.now);
    // A new session generation is a new event stream. Carrying dedup state
    // across it would silently suppress a legitimate repeated host event id.
    lane.event_ids = [];
    lane.last_durable_progress_at = null;
    lane.last_no_progress_checkpoint_at = null;
    lane.unknown_outcome_exhausted = false;
    lane.no_progress_exhausted = false;
    lane.no_artifact_exhausted = false;
    lane.terminal_tombstone = null;
    lane.durable_progress_epoch = 0;
    // A terminal workflow decision belongs to one exact invocation generation.
    // Rebinding reopens the lane; an old disposition can never close its join.
    lane.disposition = null;
    // A replaced session is a different context: every scope and remembered
    // decision bound to the previous generation is dropped.
    this.clearPermissionMemory({ full: true });
    this.updateBatchState(lane);
    this.emitMaterial('supervision.registered', {
      taskRef: lane.task_ref, role: 'controller', outcome: 'success', summary: 'Bound exact OpenCode lane session',
      data: { lane_id: lane.id, session_id: sessionId, generation: lane.session_generation, lifecycle },
    });
    this.save();
    return clone(lane);
  }

  markLaneStarted(laneId, sessionId) {
    const lane = this.findLane(laneId);
    if (lane.session_id !== sessionId) throw new Error('lane start does not match the bound session');
    lane.lifecycle = 'running';
    lane.status = 'running';
    lane.outcome = 'running';
    lane.last_observed_activity_at = nowIso(this.now);
    this.save();
  }

  findLane(target) {
    const lane = this.state.sessions.lanes.find(entry => entry.id === target || entry.session_id === target);
    if (!lane) throw new Error(`registered lane not found: ${target}`);
    return lane;
  }

  findSession(target) {
    if (target === 'root' || target === this.state.sessions.root?.id) return this.state.sessions.root ? { kind: 'root', value: this.state.sessions.root } : null;
    if (target === 'supervisor' || target === this.state.sessions.supervisor?.id) return this.state.sessions.supervisor ? { kind: 'supervisor', value: this.state.sessions.supervisor } : null;
    const lane = this.state.sessions.lanes.find(entry => entry.id === target || entry.session_id === target);
    return lane ? { kind: 'lane', value: lane } : null;
  }

  eventIsDuplicate(session, eventId) {
    if (!eventId) return false;
    if (session.event_ids?.includes(eventId)) return true;
    session.event_ids = [...(session.event_ids ?? []), eventId].slice(-20);
    return false;
  }

  recordActivity(target, { state = 'running', event_id: eventId = null, session_id: sessionId = null, durable = false, durable_ref = null } = {}) {
    const session = this.findSession(target);
    if (!session) return { ok: false, code: 'unregistered_target' };
    if (sessionId && registeredSessionId(session.value) !== sessionId) {
      this.diagnostic('stale_activity_event', { target, session_id: sessionId, current_session_id: registeredSessionId(session.value) });
      return { ok: false, code: 'stale_event' };
    }
    if (this.eventIsDuplicate(session.value, eventId)) return { ok: true, duplicate: true };
    if (TERMINAL_OUTCOMES.has(session.value.outcome)) {
      this.diagnostic('contradictory_activity_after_terminal', { target, state, event_id: eventId });
      return { ok: false, code: 'terminal_tombstone' };
    }
    session.value.last_observed_activity_at = nowIso(this.now);
    if (durable && durable_ref) {
      const timestamp = nowIso(this.now);
      session.value.last_durable_progress_at = timestamp;
      session.value.last_no_progress_checkpoint_at = timestamp;
      if (session.kind === 'lane') {
        // A verified checkpoint starts a fresh bounded observation lease. It
        // does not certify completion; only artifact reconciliation does that.
        this.state.budgets.used.lane_no_progress[session.value.id] = 0;
        session.value.no_progress_exhausted = false;
        // Durable task context materially changed, so a semantic supervisor
        // judgment recorded against the old context may no longer replay.
        session.value.durable_progress_epoch = (session.value.durable_progress_epoch ?? 0) + 1;
      }
    }
    if (state === 'idle') {
      session.value.status = 'idle';
      if (session.kind === 'root') session.value.outcome = 'unknown';
    } else if (state === 'running' || state === 'busy') {
      session.value.status = 'running';
      if (session.value.lifecycle !== 'failed_start') session.value.lifecycle = 'running';
    }
    this.save();
    return { ok: true };
  }

  recordOutcome(target, outcome, metadata = {}) {
    if (!INVOCATION_OUTCOMES.includes(outcome)) throw new Error(`unknown invocation outcome '${outcome}'`);
    const session = this.findSession(target);
    if (!session) {
      this.diagnostic('unknown_session_event', { target, outcome, metadata });
      return { ok: false, code: 'unregistered_target' };
    }
    const value = session.value;
    if (metadata.session_id && registeredSessionId(value) !== metadata.session_id) {
      this.diagnostic('stale_outcome_event', { target, outcome, session_id: metadata.session_id, current_session_id: registeredSessionId(value) });
      return { ok: false, code: 'stale_event' };
    }
    if (this.eventIsDuplicate(value, metadata.event_id)) return { ok: true, duplicate: true, outcome: value.outcome };
    if (TERMINAL_OUTCOMES.has(value.outcome) && outcome !== 'cancelled') {
      this.diagnostic('contradictory_outcome_after_terminal', { target, previous: value.outcome, received: outcome, event_id: metadata.event_id });
      return { ok: false, code: 'terminal_tombstone', outcome: value.outcome };
    }
    if (outcome === 'running') return this.recordActivity(target, { state: 'running', session_id: metadata.session_id });

    const timestamp = nowIso(this.now);
    value.outcome = outcome;
    value.last_outcome_at = timestamp;
    value.last_observed_activity_at = timestamp;
    value.status = outcome === 'waiting_permission' ? 'waiting_permission' : outcome === 'cancelled' ? 'cancelled' : 'returned';
    value.lifecycle = outcome === 'cancelled' ? 'cancelled' : outcome === 'waiting_permission' ? 'running' : 'returned';
    if (outcome === 'cancelled') value.terminal_tombstone = { outcome, at: timestamp, event_id: metadata.event_id ?? null, session_generation: value.session_generation ?? null };

    // A missing artifact and an unclassifiable host result are separate
    // failures with separate allowances. One event charges exactly one of them.
    let chargedNoArtifact = false;
    let exhausted = null;
    if (session.kind === 'lane' && outcome === 'completed') {
      const reconciliation = metadata.reconciliation ?? {};
      const verified = reconciliation.verified === true
        && reconciliation.present === true
        && VERIFIED_ARTIFACT_KINDS.has(reconciliation.kind);
      value.reconciliation = {
        verified,
        present: reconciliation.present === true,
        kind: boundedText(reconciliation.kind, 40),
        reference: boundedText(reconciliation.reference, 300),
      };
      value.artifact_valid = verified;
      value.no_artifact = !verified;
      if (verified) {
        value.last_durable_progress_at = timestamp;
      } else {
        value.outcome = 'unknown';
        value.lifecycle = 'unknown';
        chargedNoArtifact = true;
        if (!this.incrementBudget('lane_no_artifact', value.id)) {
          value.no_artifact_exhausted = true;
          exhausted = { budget: 'lane_no_artifact', target: value.id };
          this.exhaust('lane no-artifact returns', value.id, { budgetName: 'lane_no_artifact', budgetKey: value.id });
        }
      }
      this.emitMaterial('supervision.reconciled', {
        taskRef: value.task_ref,
        role: 'controller', outcome: verified ? 'success' : 'unknown', summary: verified ? 'Verified expected lane artifact' : 'Lane return lacks a verified expected artifact',
        data: { lane_id: value.id, session_id: value.session_id, artifact_valid: verified, reconciliation: value.reconciliation },
        refs: value.reconciliation.reference ? [value.reconciliation.reference] : [],
      });
    }
    if (session.kind === 'lane' && value.outcome === 'unknown' && !chargedNoArtifact) {
      if (!this.incrementBudget('lane_unknown_outcomes', value.id)) {
        value.unknown_outcome_exhausted = true;
        exhausted = { budget: 'lane_unknown_outcomes', target: value.id };
        this.exhaust('lane unknown outcomes', value.id, { budgetName: 'lane_unknown_outcomes', budgetKey: value.id });
      }
    }
    this.updateBatchState(value);
    this.state.last_outcome = { target, target_kind: session.kind, outcome: value.outcome, at: timestamp };
    this.event('internal.host_outcome', { target, target_kind: session.kind, outcome: value.outcome, event_id: metadata.event_id ?? null });
    this.save();
    return {
      ok: true,
      outcome: value.outcome,
      session_generation: value.session_generation ?? null,
      exhausted,
      recovery_allowed: !(value.unknown_outcome_exhausted === true || value.no_artifact_exhausted === true),
    };
  }

  reconcileArtifact(laneId, reconciliation) {
    const lane = this.findLane(laneId);
    const result = typeof reconciliation === 'boolean'
      ? { verified: reconciliation, present: reconciliation, kind: 'legacy', reference: '' }
      : reconciliation ?? {};
    lane.reconciliation = {
      verified: result.verified === true && result.present === true && VERIFIED_ARTIFACT_KINDS.has(result.kind),
      present: result.present === true,
      kind: boundedText(result.kind, 40),
      reference: boundedText(result.reference, 300),
    };
    lane.artifact_valid = lane.reconciliation.verified;
    lane.no_artifact = !lane.artifact_valid;
    if (lane.outcome === 'completed' && !lane.artifact_valid) {
      lane.outcome = 'unknown';
      lane.lifecycle = 'unknown';
    }
    this.updateBatchState(lane);
    this.emitMaterial('supervision.reconciled', {
      taskRef: lane.task_ref, role: 'controller', outcome: lane.artifact_valid ? 'success' : 'unknown', summary: 'Reconciled lane artifact',
      data: { lane_id: lane.id, artifact_valid: lane.artifact_valid, reconciliation: lane.reconciliation },
    });
    this.save();
    return clone(lane);
  }

  /**
   * Route one request through the three-tier evaluator.
   *
   * Kept separate from `recordPermission` so the routing decision stays a pure
   * function of the exact scope plus the immutable identity facts the kernel
   * owns. The raw scope is an argument here and is never returned.
   */
  routePermission(request, session, privateMetadata, privatePatterns, sensitive) {
    const configuredHumanOnly = new Set([...NON_NEGOTIABLE_HUMAN_ONLY, ...this.config.permissions.human_only.map(normalized)]);
    return evaluatePermissionRouting({
      operation: request.operation,
      category: privateMetadata.category,
      command: privateMetadata.command,
      maximumEffect: privateMetadata.maximum_effect,
      patterns: privatePatterns,
      paths: privateMetadata.paths,
      targets: privateMetadata.targets,
      humanOnlyCategories: configuredHumanOnly,
      hostHumanOnly: request.human_only === true,
      sensitive,
      supervisorSelf: session.kind === 'supervisor',
      authorized: Boolean(this.state.authorization),
      policy: this.permissionRouting.policy,
      projectRoot: this.projectRoot,
      workingDirectory: rawBoundedText(request.working_directory ?? privateMetadata.working_directory, 300) || null,
      transientScopeEnabled: this.permissionRouting.transient_scope.enabled,
      ...(this.permissionFileSystem ? { fileSystem: this.permissionFileSystem } : {}),
    });
  }

  recordPermission(request) {
    if (!request?.id || !request?.session_id || !request?.operation) throw new Error('permission registration requires exact request, session, and operation ids');
    const session = this.findSession(request.session_id);
    if (!session) throw new Error('permission request came from an unregistered session');
    // The unredacted metadata exists only inside this call, as the input to the
    // mechanical router and the bounded transient store. Nothing below forwards
    // it into durable, public, notified, or logged state.
    const privateMetadata = normalizePermissionMetadata(request.metadata);
    const privatePatterns = rawNormalizedArray(request.patterns);
    const risk = request.human_only
      ? { authority: 'human-only', categories: ['host_human_only'], consequence: 'host marked this request human-only' }
      : permissionRisk({ ...request, metadata: privateMetadata }, this.config);
    const { metadata, patterns, scopeFingerprint, sensitive } = publicPermissionMetadata(privateMetadata, privatePatterns, request.operation, this.permissionScopeKey);
    const routed = this.permissionRouting.router_active
      ? this.routePermission(request, session, privateMetadata, privatePatterns, sensitive)
      : null;
    const immutable = {
      session_id: request.session_id,
      session_generation: session.value.session_generation ?? 0,
      operation: publicPermissionOperation(request.operation),
      patterns,
      metadata,
      scope_fingerprint: scopeFingerprint,
      request_generation: Number.isInteger(request.request_generation) ? request.request_generation : 1,
    };
    const existing = this.state.permissions.find(entry => entry.id === request.id);
    if (existing) {
      if (exactJson(existing.immutable) !== exactJson(immutable)) throw new Error('permission request id was reused with different immutable fields');
      return clone(existing);
    }
    // Credential detection removes confidence in the classifier's bounded
    // scope, so the request stops being supervisor-eligible. All raw scope is
    // withheld from serialization regardless of this authority decision.
    const authority = routed
      ? routed.authority
      : session.kind === 'supervisor' ? 'human-only' : sensitive ? 'human-only' : risk.authority;
    const categories = routed
      ? routed.canonical_categories
      : session.kind === 'supervisor'
        ? ['supervisor_self_request']
        : sensitive ? ['sensitive_material_redacted', ...risk.categories] : risk.categories;
    const consequence = routed
      ? routed.consequence
      : session.kind === 'supervisor'
        ? 'supervisor self-approval is prohibited'
        : sensitive ? 'request carries credential-like material; its scope cannot be shown or trusted for autonomous approval' : risk.consequence;
    const permission = {
      id: request.id,
      ...immutable,
      immutable,
      lane_id: session.kind === 'lane' ? session.value.id : null,
      task_ref: session.kind === 'lane' ? session.value.task_ref : null,
      status: 'pending',
      authority,
      risk_categories: categories,
      consequence,
      created_at: nowIso(this.now),
      // Bounded routing facts. Booleans and a version, never a path or prefix.
      routing_tier: routed ? routed.tier : 'legacy',
      policy_version: routed ? routed.policy_version : null,
      containment: routed ? { ...routed.containment } : null,
      scope_complete: routed ? routed.scope_complete === true : null,
    };
    if (routed) {
      this.state.permission_routing[routed.tier] += 1;
      // The assess tier is the only path that may hold an exact scope, and only
      // when transient projection is explicitly configured. A sensitive or
      // human-only request never reaches this branch.
      if (routed.tier === 'assess' && this.permissionRouting.transient_scope.enabled) {
        const scope = buildTransientPermissionScope({
          request_id: request.id,
          operation: immutable.operation,
          command: privateMetadata.command,
          patterns: privatePatterns,
          paths: privateMetadata.paths,
          targets: privateMetadata.targets,
          working_directory: rawBoundedText(request.working_directory ?? privateMetadata.working_directory, 300) || null,
          containment: routed.containment,
          lane_id: session.kind === 'lane' ? session.value.id : null,
          task_ref: session.kind === 'lane' ? session.value.task_ref : null,
          expected_artifact: session.kind === 'lane' ? session.value.expected_artifact : null,
          authorization_generation: this.state.authorization?.generation ?? null,
          session_id: request.session_id,
          session_generation: immutable.session_generation,
        });
        if (scope) this.transientPermissionScopes.insert(request.id, scope);
        else this.diagnostic('transient_permission_scope_refused', { request_id: request.id, reason: 'sensitive_material' });
      }
    }
    // Entering a permission wait changes which timing bucket applies.
    if (!this.state.permissions.some(entry => entry.status === 'pending')) this.beginTransition();
    this.state.permissions.push(permission);
    this.recordOutcome(request.session_id, 'waiting_permission', { event_id: `permission:${request.id}`, session_id: request.session_id });
    this.event('internal.permission_registered', { request_id: permission.id, session_id: permission.session_id, authority: permission.authority });
    if (permission.authority === 'human-only') this.notify('human_permission_wait', 'A human-only OpenCode permission is waiting', { request_id: permission.id, lane_id: permission.lane_id });
    this.save();
    return clone(permission);
  }

  /**
   * The only verified internal principals. `policy` and `cache` are controller
   * -internal decision sources with strictly narrower authority than the
   * supervisor: neither may reject on its own judgment, and neither may ever
   * issue an OpenCode `always`.
   */
  previewPermissionDecision(requestId, decision, { principal, rationale = '', evidence_refs = [], cache_context: cacheContext = null, cache_entry: cacheEntry = null } = {}) {
    const permission = this.state.permissions.find(entry => entry.id === requestId);
    if (!permission) throw new Error(`permission request not found: ${requestId}`);
    if (permission.status !== 'pending') throw new Error('permission request is stale or was already answered');
    if (!['once', 'reject', 'always'].includes(decision)) throw new Error('permission decision must be once, always, or reject');
    let audit = { decided_by: principal, policy_version: null, cache_origin_decision_id: null, cache_key_version: null };
    if (principal === 'supervisor') {
      this.assertAuthorized();
      if (decision === 'always') throw new Error('OpenCode always permission approval is human-only');
      if (permission.authority !== 'supervisor-eligible') throw new Error('supervisor may not answer this permission request');
      if (permission.session_id === this.state.sessions.supervisor?.id) throw new Error('supervisor self-approval is prohibited');
    } else if (principal === 'policy') {
      this.assertAuthorized();
      if (decision !== 'once') throw new Error('the deterministic policy tier may only approve a request once');
      if (permission.routing_tier !== 'policy' || permission.authority !== 'policy-eligible') throw new Error('policy may not answer this permission request');
      if (permission.policy_version !== this.permissionRouting.policy.version) throw new Error('policy decision does not match the active policy version');
      if (permission.session_id === this.state.sessions.supervisor?.id) throw new Error('supervisor self-approval is prohibited');
      audit = { ...audit, policy_version: permission.policy_version };
    } else if (principal === 'cache') {
      this.assertAuthorized();
      if (decision === 'always') throw new Error('a replayed decision may never become an OpenCode always grant');
      if (!cacheEntry || !cacheContext) throw new Error('a replayed decision requires its complete cache context');
      if (cacheEntry.decision !== decision) throw new Error('a replayed decision must match the stored decision exactly');
      if (this.permissionDecisionCache.keyFor(cacheContext) !== cacheEntry.key) throw new Error('replayed cache context does not match its stored key');
      const current = this.permissionCacheContextFor(permission);
      if (!current || exactJson(current) !== exactJson(cacheContext)) throw new Error('replayed cache context is stale for this request');
      if (permission.authority === 'human-only') throw new Error('cache may not answer a human-only permission request');
      if (permission.session_id === this.state.sessions.supervisor?.id) throw new Error('supervisor self-approval is prohibited');
      audit = { ...audit, policy_version: permission.policy_version, cache_origin_decision_id: boundedText(cacheEntry.origin_decision_id, 120), cache_key_version: cacheEntry.key_version };
    } else if (principal !== 'operator') {
      throw new Error('permission decisions require verified policy, supervisor, cache, or operator provenance');
    }
    return {
      ...clone(permission),
      status: decision === 'once' ? 'approved_once' : decision === 'always' ? 'approved_always' : 'rejected',
      ...audit,
      decided_at: nowIso(this.now),
      rationale: boundedText(rationale, 300),
      evidence_refs: normalizedArray(evidence_refs, 10),
    };
  }

  decidePermission(requestId, decision, options = {}) {
    const decided = this.previewPermissionDecision(requestId, decision, options);
    const permission = this.state.permissions.find(entry => entry.id === requestId);
    // Leaving the last permission wait changes which timing bucket applies.
    if (this.state.permissions.filter(entry => entry.status === 'pending').length === 1) this.beginTransition();
    Object.assign(permission, decided);
    // The exact scope this decision answered is no longer needed anywhere.
    this.transientPermissionScopes.delete(requestId);
    this.recordOutcome(permission.session_id, decision === 'reject' ? 'permission_rejected' : 'running', { session_id: permission.session_id, event_id: `permission-decision:${requestId}` });
    this.emitMaterial('supervision.permission_decided', {
      taskRef: permission.task_ref, role: options.principal === 'supervisor' ? 'supervisor' : options.principal === 'operator' ? 'operator' : 'controller', outcome: decision === 'reject' ? 'rejected' : 'success', summary: `Permission ${decision} decision recorded`,
      data: { request_id: requestId, lane_id: permission.lane_id, decision, authority: permission.authority, decided_by: permission.decided_by, routing_tier: permission.routing_tier },
    });
    this.notify('permission_decision', `Permission ${decision === 'once' ? 'approved once' : decision === 'always' ? 'approved for matching requests by operator' : 'rejected'}`, { request_id: requestId, lane_id: permission.lane_id, decided_by: permission.decided_by });
    // Remember only what a bounded replay may reuse: never an operator `always`.
    if (options.principal !== 'cache' && decision !== 'always') this.rememberPermissionDecision(permission, decision, options.principal);
    this.save();
    return clone(permission);
  }

  async replyPermission(requestId, decision, options = {}) {
    if (this.permissionRepliesInFlight.has(requestId)) throw new Error('permission request already has an in-flight reply');
    const candidate = this.previewPermissionDecision(requestId, decision, options);
    this.permissionRepliesInFlight.add(requestId);
    try {
      // Preview, then host reply, then durable commit. A failed host reply
      // leaves the record pending for every principal.
      await this.host.permissionReply?.(candidate);
      return this.decidePermission(requestId, decision, options);
    } finally {
      this.permissionRepliesInFlight.delete(requestId);
    }
  }

  /**
   * Full cache context for one pending request.
   *
   * Every boundary the replay must not cross is a key component, so a hit is
   * possible only within the same project, authorization generation, lane,
   * session generation, task, operation, policy version, and durable-progress
   * epoch. Returns null when the request cannot be keyed at all.
   */
  permissionCacheContextFor(permission) {
    if (!permission || !this.state.authorization) return null;
    if (!permission.scope_fingerprint) return null;
    const lane = permission.lane_id ? this.findLane(permission.lane_id) : null;
    return permissionCacheContext({
      project_identity: this.state.controller.project_root,
      authorization_generation: this.state.authorization.generation ?? null,
      lane_id: permission.lane_id,
      session_id: permission.session_id,
      session_generation: permission.session_generation,
      task_ref: permission.task_ref,
      operation: permission.operation,
      policy_version: this.permissionRouting.policy.version,
      scope_fingerprint: permission.scope_fingerprint,
      // A lane whose durable progress advanced is materially different context
      // for a semantic judgment, so an older supervisor decision cannot replay.
      progress_epoch: lane?.durable_progress_epoch ?? 0,
    });
  }

  /** Look up a bounded replayable decision, counting the hit or miss. */
  lookupPermissionDecision(permission) {
    if (!this.permissionDecisionCache.enabled) return null;
    if (permission.authority === 'human-only') return null;
    const context = this.permissionCacheContextFor(permission);
    if (!context) return null;
    const entry = this.permissionDecisionCache.get(context);
    if (entry) this.state.permission_routing.cache_hits += 1;
    else this.state.permission_routing.cache_misses += 1;
    return entry ? { context, entry } : null;
  }

  rememberPermissionDecision(permission, decision, principal) {
    if (!this.permissionDecisionCache.enabled) return;
    if (principal !== 'policy' && principal !== 'supervisor') return;
    const context = this.permissionCacheContextFor(permission);
    if (!context) return;
    this.permissionDecisionCache.set(context, { decision, principal, origin_decision_id: permission.id });
  }

  /**
   * Read the bounded transient scope for one assess-tier request.
   *
   * Identity, authorization generation, and session generation are revalidated
   * on every read, so a stale, evicted, or replaced entry is reported as absent
   * and the caller routes to the operator.
   */
  transientPermissionScope(requestId) {
    const permission = this.state.permissions.find(entry => entry.id === requestId);
    if (!permission || permission.status !== 'pending') return null;
    const session = this.findSession(permission.session_id);
    if (!session || registeredSessionId(session.value) !== permission.session_id) return null;
    if ((session.value.session_generation ?? 0) !== permission.session_generation) return null;
    return this.transientPermissionScopes.read(requestId, {
      authorization_generation: this.state.authorization?.generation ?? null,
      session_generation: permission.session_generation,
    });
  }

  /**
   * Drop private permission memory that a lifecycle change invalidated.
   * `full` also clears the decision cache; a decision may never survive an
   * authorization change, session replacement, or controller stop.
   */
  clearPermissionMemory({ full = false, requestId = null } = {}) {
    if (requestId) {
      this.transientPermissionScopes.delete(requestId);
      return;
    }
    this.transientPermissionScopes.clear();
    if (full) this.permissionDecisionCache.clear();
  }

  incrementBudget(name, key = 'run', amount = 1) {
    const used = this.state.budgets.used[name];
    if (used === undefined) throw new Error(`unknown budget '${name}'`);
    const limit = this.state.budgets[name];
    if (typeof used === 'number') {
      this.state.budgets.used[name] += amount;
      this.noteBudgetPressure(name, 'run', this.state.budgets.used[name], limit);
      return limit === 0 ? false : this.state.budgets.used[name] <= limit;
    }
    used[key] = (used[key] ?? 0) + amount;
    this.noteBudgetPressure(name, key, used[key], limit);
    return limit === 0 ? false : used[key] <= limit;
  }

  /** Check a budget without consuming it, used to reserve coupled charges. */
  canIncrementBudget(name, key = 'run', amount = 1) {
    const used = this.state.budgets.used[name];
    if (used === undefined) throw new Error(`unknown budget '${name}'`);
    const limit = this.state.budgets[name];
    const current = typeof used === 'number' ? used : (used[key] ?? 0);
    return limit !== 0 && current + amount <= limit;
  }

  /** True once a nonzero cost ceiling has been reached or exceeded. */
  costEnforcementExhausted() {
    const limit = this.state.budgets.supervisor_cost_units;
    if (!Number.isFinite(limit) || limit === 0) return false;
    return this.state.budgets.cost_exhausted === true || this.state.budgets.used.supervisor_cost_units >= limit;
  }

  costStatus() {
    const limit = this.state.budgets.supervisor_cost_units;
    const used = this.state.budgets.used.supervisor_cost_units;
    const enforced = Number.isFinite(limit) && limit > 0;
    return {
      tracking: this.state.budgets.cost_tracking,
      enforcement: enforced ? 'enabled' : 'disabled',
      used,
      limit,
      remaining: enforced ? Math.max(0, limit - used) : null,
      exhausted: this.costEnforcementExhausted(),
    };
  }

  recordSupervisorCost(usage) {
    const units = Number(usage?.cost_units ?? usage?.cost ?? usage?.total_cost ?? NaN);
    if (!Number.isFinite(units) || units < 0) {
      this.state.budgets.cost_tracking = 'unsupported';
      return { supported: false };
    }
    this.state.budgets.cost_tracking = 'host-reported';
    const rounded = Math.ceil(units);
    // A zero ceiling deliberately disables cost enforcement while retaining the
    // host-reported measurement. It is not a misleading "zero cost allowed" cap.
    if (this.state.budgets.supervisor_cost_units === 0) {
      this.state.budgets.used.supervisor_cost_units += rounded;
      return { supported: true, units: rounded, allowed: true, enforcement: 'disabled' };
    }
    const allowed = this.incrementBudget('supervisor_cost_units', 'run', rounded);
    if (!allowed) this.state.budgets.cost_exhausted = true;
    return { supported: true, units: rounded, allowed, enforcement: 'enabled' };
  }

  createContinuationHandoff(reason) {
    return {
      authorization: this.state.authorization && { unit_id: this.state.authorization.unit_id, scope_ref: this.state.authorization.scope_ref, generation: this.state.authorization.generation },
      root: this.state.sessions.root && { id: this.state.sessions.root.id, message_id: this.state.sessions.root.message_id, session_generation: this.state.sessions.root.session_generation },
      completed_artifacts: this.state.sessions.lanes.filter(lane => lane.artifact_valid).map(lane => ({ lane_id: lane.id, task_ref: lane.task_ref, expected_artifact: lane.expected_artifact, reconciliation: lane.reconciliation })),
      lane_dispositions: this.state.sessions.lanes.map(lane => ({ lane_id: lane.id, session_id: lane.session_id, session_generation: lane.session_generation, lifecycle: lane.lifecycle, outcome: lane.outcome, artifact_valid: lane.artifact_valid })),
      pending_permissions: this.state.permissions.filter(permission => permission.status === 'pending').map(permission => ({ id: permission.id, lane_id: permission.lane_id, operation: permission.operation, request_generation: permission.request_generation })),
      batches: this.state.batches.map(batch => ({ id: batch.id, join_open: batch.join_open, required_lane_ids: batch.required_lane_ids })),
      budgets: clone(this.state.budgets),
      configured_routes: [...this.state.configuration.configured_routes],
      replacement_reason: boundedText(reason, 300),
      required_reconciliation: 'Reread canonical task, artifact, review, and ownership state before mutation.',
    };
  }

  issueActionContext({ allowed_actions, target, target_kind, request_id = null, allowed_routes = [], wake_id = randomUUID(), target_substitution_allowed = false, investigation_depth = 0 }) {
    const allowed = [...new Set(Array.isArray(allowed_actions) ? allowed_actions : [])];
    if (!allowed.length || allowed.some(action => !SUPERVISOR_ACTIONS.includes(action))) throw new Error('action context requires enumerated allowed actions');
    const session = this.findSession(target);
    if (!session || session.kind !== target_kind) throw new Error('action context target does not match a registered target kind');
    if (target_kind === 'supervisor' && allowed.some(action => ['fresh_retry', 'use_configured_fallback', 'cancel_session', 'replace_orchestrator'].includes(action))) {
      throw new Error('supervisor recovery wake may not target the supervisor session');
    }
    const permission = request_id ? this.state.permissions.find(entry => entry.id === request_id) : null;
    if (request_id && (!permission || permission.status !== 'pending')) throw new Error('action context requires an exact pending permission request');
    if (permission && permission.session_id !== registeredSessionId(session.value)) throw new Error('permission context target must be the permission session');
    const context = {
      id: randomUUID(),
      wake_id,
      issued_at: nowIso(this.now),
      allowed_actions: allowed,
      target,
      target_kind,
      target_session_id: registeredSessionId(session.value),
      target_generation: session.value.session_generation ?? 0,
      request_id,
      request_generation: permission?.request_generation ?? null,
      allowed_routes: [...new Set(allowed_routes)],
      authorization: this.state.authorization ? {
        unit_id: this.state.authorization.unit_id,
        scope_ref: this.state.authorization.scope_ref,
        generation: this.state.authorization.generation,
      } : null,
      target_substitution_allowed: target_substitution_allowed === true,
      investigation_depth: Number.isInteger(investigation_depth) && investigation_depth >= 0 ? investigation_depth : 0,
      consumed: false,
    };
    this.state.action_contexts.push(context);
    if (this.state.action_contexts.length > 100) this.state.action_contexts.splice(0, this.state.action_contexts.length - 100);
    this.save();
    return clone(context);
  }

  validateActionContext(disposition, context) {
    if (!context?.id) return { ok: false, code: 'invalid_disposition', reason: 'missing_action_context' };
    const issued = this.state.action_contexts.find(entry => entry.id === context.id);
    if (!issued || issued.consumed) return { ok: false, code: 'stale_action_context', reason: 'unknown_or_consumed_context' };
    if (this.state.controller.status === 'paused' || this.state.controller.status === 'stopped' || this.state.controller.status === 'server_lost' || this.state.controller.status === 'bridge_lost') {
      return { ok: false, code: 'stale_action_context', reason: 'controller_state_changed' };
    }
    if (!disposition || !SUPERVISOR_ACTIONS.includes(disposition.action)) return { ok: false, code: 'invalid_disposition', reason: 'unknown_action' };
    if (!issued.allowed_actions.includes(disposition.action)) return { ok: false, code: 'invalid_disposition', reason: 'action_not_allowed' };
    if (disposition.target !== issued.target) return { ok: false, code: 'invalid_disposition', reason: 'target_mismatch' };
    const current = this.findSession(issued.target);
    if (!current || current.kind !== issued.target_kind || registeredSessionId(current.value) !== issued.target_session_id || (current.value.session_generation ?? 0) !== issued.target_generation) {
      return { ok: false, code: 'stale_action_context', reason: 'target_generation_changed' };
    }
    if (issued.authorization) {
      const authorization = this.state.authorization;
      if (!authorization || authorization.unit_id !== issued.authorization.unit_id || authorization.scope_ref !== issued.authorization.scope_ref || authorization.generation !== issued.authorization.generation) {
        return { ok: false, code: 'stale_action_context', reason: 'authorization_changed' };
      }
    }
    if (issued.request_id) {
      if (disposition.request_id !== issued.request_id) return { ok: false, code: 'invalid_disposition', reason: 'request_mismatch' };
      const permission = this.state.permissions.find(entry => entry.id === issued.request_id);
      if (!permission || permission.status !== 'pending' || permission.request_generation !== issued.request_generation || permission.session_id !== registeredSessionId(current.value)) {
        return { ok: false, code: 'stale_action_context', reason: 'permission_changed' };
      }
    }
    if (disposition.action === 'use_configured_fallback') {
      const route = String(disposition.route ?? '');
      if (!issued.allowed_routes.includes(route)) return { ok: false, code: 'invalid_disposition', reason: 'route_not_allowed' };
    }
    return { ok: true, issued, current };
  }

  async startLaneRecovery(lane, handoff, operationId, route = lane.route) {
    lane.lifecycle = 'prepared';
    lane.status = 'prepared';
    lane.recovery_operation_id = operationId;
    this.save();
    let created;
    try {
      created = await this.host.createLaneSession?.({ ...clone(lane), route }, handoff, operationId);
    } catch (error) {
      lane.lifecycle = 'failed_start';
      lane.status = 'returned';
      lane.outcome = 'failed_transport';
      lane.failed_start = { stage: 'session_created', at: nowIso(this.now), error: boundedText(error?.message, 240) };
      this.save();
      return { ok: false, code: 'failed_start', stage: 'session_created' };
    }
    if (!created?.session_id) return { ok: false, code: 'failed_start', stage: 'session_created' };
    lane.lifecycle = 'session_created';
    lane.created_session_id = created.session_id;
    this.bindLaneSession(lane.id, created.session_id, { lifecycle: 'bound', operationId });
    lane.lifecycle = 'starting';
    this.save();
    try {
      await this.host.startLane?.(clone(lane), handoff, operationId);
      this.markLaneStarted(lane.id, created.session_id);
      return { ok: true, session_id: created.session_id };
    } catch (error) {
      lane.lifecycle = 'failed_start';
      lane.status = 'returned';
      lane.outcome = 'failed_transport';
      lane.failed_start = { stage: 'prompt', at: nowIso(this.now), error: boundedText(error?.message, 240) };
      try {
        await this.host.abortSession?.(created.session_id);
        lane.cleanup = { attempted: true, session_id: created.session_id, at: nowIso(this.now) };
      } catch (cleanupError) {
        lane.cleanup = { attempted: true, session_id: created.session_id, failed: true, error: boundedText(cleanupError?.message, 240), at: nowIso(this.now) };
      }
      this.save();
      return { ok: false, code: 'failed_start', stage: 'prompt', session_id: created.session_id };
    }
  }

  async replaceRoot(handoff, operationId) {
    const current = this.state.sessions.root;
    if (!current?.id) return { ok: false, code: 'invalid_disposition', reason: 'missing_root' };
    let candidate;
    try {
      candidate = await this.host.createRoot?.(clone(current), handoff, operationId);
    } catch (error) {
      return { ok: false, code: 'failed_start', stage: 'session_created', message: boundedText(error?.message, 240) };
    }
    if (!candidate?.session_id) return { ok: false, code: 'failed_start', stage: 'session_created' };
    this.state.root_replacement = { operation_id: operationId, old_root_id: current.id, candidate_session_id: candidate.session_id, lifecycle: 'session_created', created_at: nowIso(this.now) };
    this.save();
    try {
      await this.host.abortSession?.(current.id);
    } catch (error) {
      this.state.root_replacement.lifecycle = 'cancelled';
      this.state.root_replacement.abort_error = boundedText(error?.message, 240);
      try { await this.host.abortSession?.(candidate.session_id); } catch (cleanupError) { this.state.root_replacement.cleanup_error = boundedText(cleanupError?.message, 240); }
      this.save();
      return { ok: false, code: 'failed_cancellation', target: 'root' };
    }
    current.outcome = 'cancelled';
    current.status = 'cancelled';
    current.lifecycle = 'cancelled';
    current.terminal_tombstone = { outcome: 'cancelled', at: nowIso(this.now), reason: 'root_replaced' };
    this.registerRoot({ session_id: candidate.session_id, project_root: this.state.controller.project_root, agent: 'orchestrator', directory: candidate.directory, worktree: candidate.worktree });
    const replacement = this.state.sessions.root;
    replacement.lifecycle = 'starting';
    replacement.status = 'starting';
    this.state.root_replacement.lifecycle = 'starting';
    this.save();
    try {
      await this.host.startRoot?.(clone(replacement), handoff, operationId);
      replacement.lifecycle = 'running';
      replacement.status = 'running';
      replacement.outcome = 'running';
      this.state.root_replacement.lifecycle = 'running';
      this.save();
      return { ok: true, session_id: replacement.id };
    } catch (error) {
      replacement.lifecycle = 'failed_start';
      replacement.status = 'returned';
      replacement.outcome = 'failed_transport';
      replacement.failed_start = { stage: 'prompt', at: nowIso(this.now), error: boundedText(error?.message, 240) };
      this.state.root_replacement.lifecycle = 'failed_start';
      this.save();
      return { ok: false, code: 'failed_start', stage: 'prompt', session_id: replacement.id };
    }
  }

  async applyDisposition(disposition, { actionContext, modelAvailable = true } = {}) {
    const validation = this.validateActionContext(disposition, actionContext);
    if (!validation.ok) return validation;
    const { issued, current } = validation;
    const action = disposition.action;
    if (AUTHORIZATION_REQUIRED_ACTIONS.has(action)) {
      try { this.assertAuthorized(); } catch (error) { return { ok: false, code: 'stale_action_context', reason: boundedText(error.message, 120) }; }
    }
    if (MODEL_ACTIONS.has(action) && !modelAvailable) return { ok: false, code: 'supervisor_model_unavailable' };
    if (action === 'message_session' && !this.state.capabilities.live_message_injection) return { ok: false, code: 'unsupported_capability', capability: 'live_message_injection' };
    if (action === 'terminate_owned_process') return { ok: false, code: 'unsupported_capability', capability: 'process_termination' };
    issued.consumed = true;
    const rationale = boundedText(disposition.rationale, 300);
    this.state.last_disposition = { action, target: issued.target, target_kind: issued.target_kind, request_id: issued.request_id, rationale, evidence_refs: normalizedArray(disposition.evidence_refs, 10), action_context_id: issued.id, at: nowIso(this.now) };
    this.emitMaterial('supervision.assessed', {
      taskRef: current.kind === 'lane' ? current.value.task_ref : null,
      role: 'supervisor', outcome: 'success', summary: 'Supervisor assessment produced a bounded disposition',
      data: { action, target: issued.target, target_kind: issued.target_kind, request_id: issued.request_id, action_context_id: issued.id },
    });

    if (action === 'continue_observing' || action === 'investigate' || action === 'request_operator') {
      if (action === 'request_operator') {
        this.beginTransition();
        this.state.controller.status = 'waiting_operator';
        // The operator reviews the exact scope in OpenCode's native prompt, so
        // the transient copy has no further purpose once the model escalates.
        if (issued.request_id) this.clearPermissionMemory({ requestId: issued.request_id });
        this.notify('operator_action', 'Supervisor requires operator action', { target: issued.target, rationale });
      }
      this.save();
      // Investigation chains are bounded locally by the action context's own
      // depth, not by a controller-lifetime per-target counter.
      const depth = issued.investigation_depth ?? 0;
      const remaining = Math.max(0, (this.config.recovery?.max_investigation_depth ?? 2) - depth);
      return {
        ok: true,
        action,
        target: issued.target,
        follow_up_allowed: action === 'investigate' && remaining > 0,
        investigation_depth: depth,
        investigation_depth_remaining: action === 'investigate' ? remaining : null,
      };
    }
    if (action === 'approve_permission_once' || action === 'reject_permission') {
      const decision = action === 'approve_permission_once' ? 'once' : 'reject';
      const permission = await this.replyPermission(issued.request_id, decision, { principal: 'supervisor', rationale, evidence_refs: disposition.evidence_refs });
      return { ok: true, action, permission };
    }
    if (action === 'cancel_session') {
      return await this.cancelSession(issued.target, { principal: 'supervisor', rationale });
    }
    if (action === 'fresh_retry' || action === 'use_configured_fallback') {
      if (current.kind !== 'lane') return { ok: false, code: 'invalid_disposition', reason: 'lane_action_requires_lane' };
      const lane = current.value;
      let route = lane.route;
      if (action === 'fresh_retry') {
        if (!this.incrementBudget('lane_infrastructure_retries', lane.id)) return this.exhaust('lane infrastructure recovery', lane.id, { budgetName: 'lane_infrastructure_retries', budgetKey: lane.id });
      } else {
        route = String(disposition.route);
        if (!this.config.fallback_routes.some(entry => entry.model === route)) return { ok: false, code: 'invalid_disposition', reason: 'route_not_configured' };
        if (!this.incrementBudget('route_fallbacks')) return this.exhaust('route fallback', lane.id, { budgetName: 'route_fallbacks', budgetKey: 'run' });
      }
      const result = await this.startLaneRecovery(lane, this.createContinuationHandoff(rationale), issued.id, route);
      if (!result.ok) return result;
      lane.route = route;
      this.emitMaterial('supervision.retried', { taskRef: lane.task_ref, role: 'supervisor', outcome: 'success', summary: action === 'fresh_retry' ? 'Lane reinvoked from durable state' : 'Lane reinvoked on configured fallback', data: { lane_id: lane.id, session_id: result.session_id, route } });
      this.notify(action === 'fresh_retry' ? 'recovery' : 'route_change', action === 'fresh_retry' ? 'Lane reinvoked from durable state' : 'Lane reinvoked on an explicitly configured fallback route', { lane_id: lane.id, route });
      return { ok: true, action, lane_id: lane.id, session_id: result.session_id, route };
    }
    if (action === 'replace_orchestrator') {
      if (current.kind !== 'root') return { ok: false, code: 'invalid_disposition', reason: 'root_action_requires_root' };
      if (!this.incrementBudget('root_replacements')) return this.exhaust('root replacement', 'root', { budgetName: 'root_replacements', budgetKey: 'run' });
      const result = await this.replaceRoot(this.createContinuationHandoff(rationale), issued.id);
      if (!result.ok) return result;
      this.emitMaterial('supervision.root_replaced', { role: 'supervisor', outcome: 'success', summary: 'Fresh orchestrator started from a bounded continuation handoff', data: { session_id: result.session_id } });
      this.notify('root_replacement', 'Fresh orchestrator started from a bounded continuation handoff', { replacement_reason: rationale });
      return { ok: true, action, session_id: result.session_id };
    }
    if (action === 'resume_work_unit') {
      if (this.state.controller.status === 'paused') return { ok: false, code: 'stale_action_context', reason: 'controller_paused' };
      if (this.state.server.status !== 'connected') return { ok: false, code: 'server_unavailable' };
      if (this.state.bridge.status !== 'connected') return { ok: false, code: 'bridge_unavailable' };
      const reconciliation = await this.host.reconcile?.(this.createContinuationHandoff(rationale));
      this.beginTransition();
      this.state.controller.status = this.state.authorization ? 'authorized' : 'observing';
      this.event('internal.resume_marker', { reconciliation: compactDiagnostic(reconciliation ?? {}) });
      this.save();
      return { ok: true, action, continuation: this.createContinuationHandoff('control-plane resume marker'), reconciliation: compactDiagnostic(reconciliation ?? {}) };
    }
    if (action === 'record_block') {
      // A block is durable state on the exact lane, not an ephemeral object the
      // caller may or may not persist.
      let laneBlock = null;
      if (current.kind === 'lane') {
        laneBlock = this.recordLaneDisposition(current.value.id, 'blocked', {
          provenance: 'supervisor',
          reason: rationale,
          evidence_refs: disposition.evidence_refs,
        });
      } else {
        this.state.root_block = { target: issued.target, target_kind: issued.target_kind, reason: rationale, provenance: 'supervisor', at: nowIso(this.now) };
      }
      this.notify('operator_action', 'Supervisor recorded a durable blocker request', { target: issued.target, rationale });
      this.save();
      return { ok: true, action, target: issued.target, block: laneBlock ?? clone(this.state.root_block) };
    }
    return { ok: false, code: 'unsupported_action' };
  }

  /**
   * The single cancellation path for both operator commands and supervisor
   * dispositions. On abort failure it records the exact target, session,
   * generation, attempted provenance, and a durable `failed_cancellation`
   * outcome; it never invents a successful termination. Successful cancellation
   * keeps the terminal tombstone so late host events stay ignored.
   */
  async cancelSession(target, { principal, rationale = '' } = {}) {
    if (!['operator', 'supervisor'].includes(principal)) throw new Error('cancellation requires operator or supervisor provenance');
    const session = this.findSession(target);
    if (!session) return { ok: false, code: 'unregistered_target', target };
    const sessionId = registeredSessionId(session.value);
    const generation = session.value.session_generation ?? 0;
    const taskRef = session.kind === 'lane' ? session.value.task_ref : null;
    try {
      await this.host.abortSession?.(sessionId);
    } catch (error) {
      const failure = {
        target,
        target_kind: session.kind,
        session_id: sessionId,
        session_generation: generation,
        attempted_by: principal,
        classification: 'failed_cancellation',
        error: boundedText(error?.message, 240),
        at: nowIso(this.now),
      };
      session.value.failed_cancellation = failure;
      this.recordOutcome(target, 'failed_cancellation', { session_id: sessionId });
      this.emitMaterial('supervision.cancelled', {
        taskRef, role: principal, outcome: 'failure', summary: 'Registered session cancellation failed',
        data: failure,
      });
      this.notify('cancellation', 'Registered session cancellation failed and requires follow-up', { target, session_id: sessionId, attempted_by: principal });
      this.save();
      return { ok: false, code: 'failed_cancellation', target, ...failure };
    }
    session.value.failed_cancellation = null;
    this.recordOutcome(target, 'cancelled', { session_id: sessionId });
    if (session.kind === 'lane') {
      this.recordLaneDisposition(session.value.id, 'cancelled', { provenance: principal, reason: rationale });
    }
    this.emitMaterial('supervision.cancelled', {
      taskRef, role: principal, outcome: 'cancelled', summary: 'Registered session cancelled',
      data: { target, target_kind: session.kind, session_id: sessionId, session_generation: generation, attempted_by: principal },
    });
    this.notify('cancellation', 'Registered session cancelled', { target, session_id: sessionId, attempted_by: principal, rationale: boundedText(rationale, 240) });
    this.save();
    return { ok: true, action: 'cancel_session', target, session_id: sessionId, session_generation: generation };
  }

  exhaust(kind, target, { budgetName = null, budgetKey = target } = {}) {
    this.emitMaterial('supervision.exhausted', { role: 'controller', outcome: 'exhausted', summary: `${kind} budget exhausted`, data: { kind, target } });
    const marker = budgetName ? `${budgetName}:${budgetKey}` : null;
    const alreadyNotified = marker && this.state.budget_notifications?.[marker] === 'exhausted';
    if (!alreadyNotified) {
      if (marker) {
        this.state.budget_notifications = this.state.budget_notifications ?? {};
        this.state.budget_notifications[marker] = 'exhausted';
      }
      this.notify('budget', `${kind} budget exhausted`, { target, ...(budgetName ? { budget: budgetName } : {}) });
    }
    this.save();
    return { ok: false, code: 'budget_exhausted', target };
  }

  markBridgeConnected(identity = {}) {
    this.beginTransition();
    if (identity.server_identity) this.state.server.identity = boundedText(identity.server_identity, 200);
    if (identity.server_url) this.state.server.url = boundedText(identity.server_url, 500);
    this.state.server.status = 'connected';
    this.state.capabilities = attachedCapabilities(identity.capabilities);
    this.state.capability_provenance = capabilityProvenance(this.state.capabilities, identity.capabilities);
    this.state.bridge = { status: 'connected', project_root: this.state.controller.project_root, run_id: this.state.controller.run_id, server_identity: boundedText(identity.server_identity, 200) || this.state.server.identity, last_connected_at: nowIso(this.now), last_lost_at: null };
    if (this.state.controller.status === 'bridge_lost') this.state.controller.status = this.state.authorization ? 'authorized' : 'observing';
    this.save();
  }

  markBridgeLost(reason = 'OpenCode bridge disconnected') {
    this.beginTransition();
    this.state.bridge.status = 'lost';
    this.state.bridge.last_lost_at = nowIso(this.now);
    if (this.state.controller.status !== 'stopped') this.state.controller.status = 'bridge_lost';
    // No host can accept a reply now, so no pending scope may be projected.
    this.clearPermissionMemory({ full: true });
    this.event('internal.bridge_lost', { reason });
    this.notify('controller_loss', 'Attached OpenCode bridge disconnected; model and host actions are paused', { reason });
    this.save();
  }

  markServerLost(reason = 'OpenCode server became unavailable') {
    this.beginTransition();
    this.state.server.status = 'lost';
    if (this.state.controller.status !== 'stopped') this.state.controller.status = 'server_lost';
    this.clearPermissionMemory({ full: true });
    this.event('internal.server_lost', { reason });
    this.notify('server_loss', 'Attached OpenCode server recovery is unsupported; controller state was preserved', { reason });
    this.save();
  }

  pause() {
    if (this.state.controller.status === 'stopped') throw new Error('supervision controller is stopped');
    this.beginTransition();
    this.state.controller.status = 'paused';
    // A paused controller answers nothing, so no transient scope stays live.
    // Remembered decisions survive a pause/resume within the same generation.
    this.clearPermissionMemory();
    this.event('internal.paused');
    this.save();
  }

  resume() {
    if (this.state.controller.status === 'stopped') throw new Error('supervision controller is stopped');
    if (this.state.server.status === 'lost') throw new Error('cannot resume attached supervision after server loss');
    if (this.state.bridge.status !== 'connected') throw new Error('cannot resume attached supervision while the bridge is unavailable');
    this.beginTransition();
    this.state.controller.status = this.state.authorization ? 'authorized' : 'observing';
    this.event('internal.resumed');
    this.save();
  }

  stop() {
    if (this.state.controller.status === 'stopped') return;
    this.beginTransition();
    this.state.controller.status = 'stopped';
    this.clearPermissionMemory({ full: true });
    this.emitMaterial('supervision.terminated', { role: 'operator', outcome: 'success', summary: 'Supervision controller stopped', data: { run_id: this.state.controller.run_id } });
    this.notify('terminal', 'Supervision controller stopped', {});
    this.save();
  }

  /**
   * Authenticated, explicitly public reattachment snapshot.
   *
   * A reconnecting bridge cannot rebuild its lane registry from the handshake
   * alone, so this returns the safe per-lane facts it needs. It never returns
   * permission metadata: pending host permissions must be re-enumerated by the
   * host, never recreated from stale local state.
   */
  reattachmentSnapshot() {
    return {
      run_id: this.state.controller.run_id,
      project_root: this.state.controller.project_root,
      server_identity: this.state.server.identity,
      root: this.state.sessions.root && { session_id: this.state.sessions.root.id, session_generation: this.state.sessions.root.session_generation, lifecycle: this.state.sessions.root.lifecycle, status: this.state.sessions.root.status },
      supervisor: this.state.sessions.supervisor && { session_id: this.state.sessions.supervisor.id, session_generation: this.state.sessions.supervisor.session_generation, lifecycle: this.state.sessions.supervisor.lifecycle },
      authorization: this.state.authorization && { unit_id: this.state.authorization.unit_id, scope_ref: this.state.authorization.scope_ref, generation: this.state.authorization.generation },
      lanes: this.state.sessions.lanes
        .filter(lane => lane.session_id && !TERMINAL_LIFECYCLES.has(lane.lifecycle))
        .map(lane => ({
          lane_id: lane.id,
          role: lane.role,
          session_id: lane.session_id,
          session_generation: lane.session_generation,
          task_ref: lane.task_ref,
          expected_artifact: lane.expected_artifact,
          lifecycle: lane.lifecycle,
          status: lane.status,
          route: lane.route,
          authorization_generation: lane.authorization?.generation ?? null,
        })),
      // Attached mode cannot enumerate live host permissions; the documented
      // ceiling stays visible instead of being papered over.
      pending_permission_reconstruction: 'host-enumeration-unsupported',
    };
  }

  /**
   * Reconcile a reattaching bridge's reported live sessions against the
   * controller's registry. Only sessions the same pinned server still reports
   * are accepted; anything else is marked unknown for bounded reconciliation.
   */
  reconcileReattachment({ live_session_ids: liveSessionIds = [] } = {}) {
    const live = new Set(normalizedArray(liveSessionIds, 200));
    const snapshot = this.reattachmentSnapshot();
    const reconciled = [];
    const unknown = [];
    for (const lane of snapshot.lanes) {
      if (live.has(lane.session_id)) reconciled.push(lane);
      else unknown.push({ ...lane, reason: 'session_not_reported_by_server' });
    }
    for (const entry of unknown) {
      const lane = this.state.sessions.lanes.find(candidate => candidate.id === entry.lane_id);
      if (!lane) continue;
      lane.reconciliation_state = 'unknown_after_reattachment';
      this.diagnostic('lane_unknown_after_reattachment', { lane_id: lane.id, session_id: lane.session_id });
    }
    for (const entry of reconciled) {
      const lane = this.state.sessions.lanes.find(candidate => candidate.id === entry.lane_id);
      if (lane) lane.reconciliation_state = 'reconciled';
    }
    this.save();
    return { ...snapshot, lanes: reconciled, unknown_lanes: unknown };
  }

  /**
   * Model-safe view. The supervisor needs registered identities, lifecycle,
   * artifacts, budgets, and timing to choose a bounded action; it does not need
   * the operator's local endpoint, notification history, diagnostics, or raw
   * event ring, so those never enter a provider-bound payload.
   */
  modelView(options = {}) {
    const status = this.status(options);
    return {
      schema_version: status.schema_version,
      controller: { mode: status.controller.mode, status: status.controller.status, adapter: status.controller.adapter },
      authorization: status.authorization,
      server: { status: status.server.status },
      bridge: { status: status.bridge.status },
      sessions: status.sessions,
      batches: status.batches,
      permissions: status.permissions,
      permission_routing: status.permission_routing,
      budgets: status.budgets,
      timing: { active_minutes: status.timing.active_minutes, absolute_age_minutes: status.timing.absolute_age_minutes },
      last_outcome: status.last_outcome,
      unsupported_capabilities: status.unsupported_capabilities,
      collections: status.collections,
    };
  }

  /**
   * Compact, secret-free operational summary for human-readable CLI output.
   */
  humanSummary(options = {}) {
    const status = this.status(options);
    const budgets = status.budgets;
    const bounded = Object.entries(budgets.configured)
      .filter(([name, limit]) => Number.isInteger(limit) && limit > 0 && typeof budgets.used[name] === 'number')
      .map(([name, limit]) => ({ name, used: budgets.used[name], limit, remaining: Math.max(0, limit - budgets.used[name]) }));
    return {
      controller: status.controller,
      authorization: status.authorization,
      server: status.server,
      bridge: status.bridge,
      root: status.sessions.root,
      supervisor: status.sessions.supervisor,
      lanes: status.collections.lanes,
      pending_permissions: status.collections.pending_permissions,
      budgets: bounded,
      cost: status.budgets.cost,
      timing: { active_minutes: status.timing.active_minutes, absolute_age_minutes: status.timing.absolute_age_minutes, paused_ms: status.timing.paused_ms, permission_wait_ms: status.timing.permission_wait_ms, human_wait_ms: status.timing.human_wait_ms },
      unsupported_capabilities: status.unsupported_capabilities,
      notifications: status.notification_summary,
    };
  }

  status(options = {}) {
    const lanes = collection(this.state.sessions.lanes.map(publicLane), options.lanes);
    const pending = collection(this.state.permissions.filter(permission => permission.status === 'pending').map(publicPermission), options.pending_permissions);
    const decided = collection(this.state.permissions.filter(permission => permission.status !== 'pending').map(publicPermission), options.decided_permissions);
    const notifications = collection(this.state.notifications.map(notification => ({ id: notification.id, sequence: notification.sequence ?? 0, at: notification.at, kind: notification.kind, summary: notification.summary, read: notification.read })), options.notifications);
    const events = collection(this.state.events.map(event => ({ id: event.id, at: event.at, type: event.type, data: compactDiagnostic(event.data) })), options.events);
    const unsupported = Object.entries(this.state.capabilities).filter(([, supported]) => !supported).map(([capability]) => capability);
    return {
      schema_version: this.state.schema_version,
      controller: {
        run_id: this.state.controller.run_id,
        controller_id: this.state.controller.controller_id,
        project_root: this.state.controller.project_root,
        adapter: this.state.controller.adapter,
        mode: this.state.controller.mode,
        status: this.state.controller.status,
        version: this.state.controller.version,
        started_at: this.state.controller.started_at,
        updated_at: this.state.controller.updated_at,
      },
      authorization: this.state.authorization ? {
        unit_id: this.state.authorization.unit_id,
        scope_ref: this.state.authorization.scope_ref,
        provenance: this.state.authorization.authorized_by,
        authorized_at: this.state.authorization.authorized_at,
      } : null,
      server: { status: this.state.server.status, identity: this.state.server.identity, last_reconciled_at: this.state.server.last_reconciled_at },
      bridge: { status: this.state.bridge.status, last_connected_at: this.state.bridge.last_connected_at, last_lost_at: this.state.bridge.last_lost_at },
      sessions: {
        root: this.state.sessions.root && { id: this.state.sessions.root.id, session_generation: this.state.sessions.root.session_generation, status: this.state.sessions.root.status, lifecycle: this.state.sessions.root.lifecycle, outcome: this.state.sessions.root.outcome, last_observed_activity_at: this.state.sessions.root.last_observed_activity_at ?? null },
        supervisor: this.state.sessions.supervisor && { id: this.state.sessions.supervisor.id, session_generation: this.state.sessions.supervisor.session_generation, status: this.state.sessions.supervisor.status, lifecycle: this.state.sessions.supervisor.lifecycle },
        lanes: lanes.items,
      },
      batches: this.state.batches.map(batch => ({ id: batch.id, required_lane_ids: [...batch.required_lane_ids], join_condition: batch.join_condition, join_open: batch.join_open, lanes: clone(batch.lanes) })),
      processes: this.state.processes.map(process => ({ id: process.id, status: process.status, provenance: process.provenance ?? 'unsupported' })),
      process_capability: { supported: this.state.capabilities.process_termination, provenance: this.state.capabilities.process_termination ? 'host-verified' : 'attached-mode-unavailable' },
      permissions: { pending: pending.items, decided: decided.items },
      // Aggregate routing and replay metrics only: counts, never a key, a
      // fingerprint, or a scope.
      permission_routing: {
        mode: this.permissionRouting.mode,
        policy_version: this.permissionRouting.policy.version,
        transient_scope: this.permissionRouting.transient_scope.mode,
        transient_entries: this.transientPermissionScopes.size,
        routed: {
          policy: this.state.permission_routing.policy,
          assess: this.state.permission_routing.assess,
          human: this.state.permission_routing.human,
        },
        cache: {
          enabled: this.permissionDecisionCache.enabled,
          entries: this.permissionDecisionCache.size,
          hits: this.state.permission_routing.cache_hits,
          misses: this.state.permission_routing.cache_misses,
        },
      },
      budgets: {
        configured: Object.fromEntries(Object.entries(this.state.budgets).filter(([key]) => !['used', 'cost_tracking', 'cost_exhausted'].includes(key))),
        used: clone(this.state.budgets.used),
        cost_tracking: this.state.budgets.cost_tracking,
        cost: this.costStatus(),
      },
      timing: { ...clone(this.state.timing), active_minutes: this.state.timing.active_ms / 60_000, absolute_age_minutes: this.state.timing.absolute_age_ms / 60_000 },
      last_outcome: clone(this.state.last_outcome),
      last_disposition: clone(this.state.last_disposition),
      root_block: this.state.root_block ? clone(this.state.root_block) : null,
      rate_limit_backoffs: clone(this.state.rate_limit_backoffs ?? []),
      capabilities: clone(this.state.capabilities),
      capability_provenance: clone(this.state.capability_provenance),
      unsupported_capabilities: unsupported,
      notifications: notifications.items,
      notification_summary: {
        total: this.state.notifications.length,
        unread: this.unreadNotificationCount(),
        acknowledged_through: this.state.notification_cursor ?? 0,
        latest_sequence: this.state.notification_sequence ?? 0,
      },
      recent_events: events.items,
      collections: {
        lanes: Object.fromEntries(Object.entries(lanes).filter(([key]) => key !== 'items')),
        pending_permissions: Object.fromEntries(Object.entries(pending).filter(([key]) => key !== 'items')),
        decided_permissions: Object.fromEntries(Object.entries(decided).filter(([key]) => key !== 'items')),
        notifications: Object.fromEntries(Object.entries(notifications).filter(([key]) => key !== 'items')),
        events: Object.fromEntries(Object.entries(events).filter(([key]) => key !== 'items')),
      },
    };
  }
}
