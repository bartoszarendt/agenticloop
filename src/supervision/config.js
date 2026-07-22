/**
 * Strict configuration for the optional supervision component. Keeping this
 * separate from normal adapter settings ensures an ordinary installation never
 * starts a controller or acquires runtime dependencies.
 */

import {
  CANONICAL_PERMISSION_OPERATIONS,
  DEFAULT_PROTECTED_PATHS,
  POLICY_ELIGIBLE_AUTO_OPERATIONS,
  normalizePermissionOperation,
  validateBashRule,
} from './permission-policy.js';

/**
 * Configuration schema version.
 *
 * Version 1 is the once-only envelope shipped with the permission bridge.
 * Version 2 adds the three-tier `policy` / `assess` / `human` router, transient
 * supervisor scope, structured command rules, and bounded decision memory.
 * Existing version 1 configuration keeps version 1 behaviour: the new router is
 * reached only by setting `permissions.mode` explicitly.
 */
export const SUPERVISION_CONFIG_VERSION = 2;

export const PERMISSION_ROUTING_MODES = Object.freeze(['eligible-once-only', 'policy-assess-human']);
export const TRANSIENT_SCOPE_MODES = Object.freeze(['disabled', 'redacted-provider']);

/**
 * The one machine-readable definition of the pinned attached-host range. The
 * displayed range string and the version comparison are both derived from it,
 * so a bump cannot leave documentation and enforcement disagreeing. A narrow
 * stable-only tuple comparison is deliberate: it needs no runtime dependency.
 */
export const OPENCODE_VERSION_BOUNDS = Object.freeze({
  minimum: Object.freeze([1, 18, 4]),
  exclusive_maximum: Object.freeze([1, 19, 0]),
});

function formatVersionBound(bound) {
  return bound.join('.');
}

export const SUPPORTED_OPENCODE_VERSION_RANGE =
  `>=${formatVersionBound(OPENCODE_VERSION_BOUNDS.minimum)} <${formatVersionBound(OPENCODE_VERSION_BOUNDS.exclusive_maximum)}`;

export const DEFAULT_SUPERVISION_CONFIG = Object.freeze({
  enabled: false,
  execution: {
    adapter: 'opencode',
    transport: 'server',
    launch: 'attached-on-activation',
  },
  supervisor: {
    adapter: 'opencode',
    enabled: true,
    required: true,
    route: 'supervisor',
    model: '',
  },
  activation: {
    flag: '--supervised',
    minimum_capability: 'attached-live',
    fail_closed: true,
  },
  permissions: {
    // Version 1 behaviour. The three-tier router is opt-in and never reached by
    // upgrading the package alone.
    mode: 'eligible-once-only',
    supervisor_decision: 'eligible-once-only',
    always: 'human',
    high_impact: 'human',
    // Explicit provider egress. `disabled` means the supervisor is never shown
    // a permission scope, and every assess candidate routes to the operator.
    transient_scope: {
      mode: 'disabled',
      maximum_age_seconds: 120,
      maximum_entries: 50,
    },
    // Deterministic policy tier. Empty by default: enabling the router alone
    // approves nothing until an operator opts each capability in.
    policy: {
      version: 1,
      auto_operations: [],
      protected_paths: [],
      bash_rules: [],
    },
    // Bounded, in-memory decision memory. Never an OpenCode `always` grant.
    decision_cache: {
      enabled: false,
      maximum_entries: 200,
      policy_ttl_seconds: 900,
      supervisor_ttl_seconds: 300,
      rejection_ttl_seconds: 600,
    },
    eligible_operations: ['read', 'grep', 'glob', 'list', 'search', 'webfetch', 'bash'],
    eligible_bash_patterns: [
      'git status',
      'git diff',
      'git log',
      'git show',
      'git branch --show-current',
      'npm test',
      'npm run test',
      'npx agenticloop validate',
    ],
    human_only: [
      'destructive_cleanup',
      'merge',
      'release',
      'publication',
      'credentials',
      'authentication',
      'external_communication',
      'authorization_expansion',
      'locked_decision',
      'backend_exception',
    ],
  },
  budgets: {
    lane_infrastructure_retries: 2,
    lane_no_progress: 2,
    lane_no_artifact: 2,
    lane_unknown_outcomes: 1,
    route_fallbacks: 0,
    root_replacements: 1,
    supervisor_replacements: 1,
    supervisor_wakeups: 20,
    supervisor_cost_units: 0,
    permission_assessments: 20,
    active_minutes: 480,
    absolute_age_minutes: 1440,
  },
  recovery: {
    max_rate_limit_delay_minutes: 15,
    no_progress_minutes: 5,
    // Bounds an autonomous investigate -> investigate chain. It is not a cap on
    // explicit operator investigations, which are limited only by the ordinary
    // wake and cost budgets.
    max_investigation_depth: 2,
  },
  notifications: {
    native: true,
    history_limit: 20,
    // Percentage of a bounded budget at which one "approaching" notification is
    // emitted. Each budget notifies at most once per threshold and once on
    // exhaustion; routine observation never notifies.
    approaching_threshold_percent: 80,
  },
  fallback_routes: [],
});

const HUMAN_ONLY_PERMISSION_CATEGORIES = new Set(DEFAULT_SUPERVISION_CONFIG.permissions.human_only);
const POSITIVE_BUDGETS = new Set(Object.keys(DEFAULT_SUPERVISION_CONFIG.budgets));
const CONFIG_KEYS = new Set(Object.keys(DEFAULT_SUPERVISION_CONFIG));
const SECTION_KEYS = Object.fromEntries(
  Object.entries(DEFAULT_SUPERVISION_CONFIG)
    .filter(([, value]) => isPlainObject(value))
    .map(([key, value]) => [key, new Set(Object.keys(value))])
);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = merge(base[key], value);
  return result;
}

function requireBoolean(value, name, errors) {
  if (typeof value !== 'boolean') errors.push(`${name} must be a boolean`);
}

function requireString(value, name, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${name} must be a non-empty string`);
}

function requireBoundedInteger(value, name, minimum, maximum, errors) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

const PERMISSION_SUBSECTION_KEYS = Object.freeze({
  transient_scope: new Set(Object.keys(DEFAULT_SUPERVISION_CONFIG.permissions.transient_scope)),
  policy: new Set(Object.keys(DEFAULT_SUPERVISION_CONFIG.permissions.policy)),
  decision_cache: new Set(Object.keys(DEFAULT_SUPERVISION_CONFIG.permissions.decision_cache)),
});

const CANONICAL_OPERATION_SET = new Set(CANONICAL_PERMISSION_OPERATIONS);
const POLICY_AUTO_OPERATION_SET = new Set(POLICY_ELIGIBLE_AUTO_OPERATIONS);
const DEFAULT_PROTECTED_PATH_SET = new Set(DEFAULT_PROTECTED_PATHS);

/**
 * Validate the version 2 permission router sections.
 *
 * Every bound is explicit and every unknown key is rejected. A section that is
 * configured but unusable in the active mode is an error rather than a silently
 * ignored setting, so an operator cannot believe transient scope or decision
 * memory is active when the legacy envelope is still in force.
 */
function validatePermissionRouting(permissions, rawPermissions, errors) {
  if (!PERMISSION_ROUTING_MODES.includes(permissions.mode)) {
    errors.push(`supervision.permissions.mode must be one of: ${PERMISSION_ROUTING_MODES.join(', ')}`);
  }
  for (const [section, allowed] of Object.entries(PERMISSION_SUBSECTION_KEYS)) {
    if (!isPlainObject(permissions[section])) {
      errors.push(`supervision.permissions.${section} must be an object`);
      continue;
    }
    if (!isPlainObject(rawPermissions?.[section])) continue;
    for (const key of Object.keys(rawPermissions[section])) {
      if (!allowed.has(key)) errors.push(`supervision.permissions.${section}.${key} is not supported`);
    }
  }
  if (errors.length > 0) return;

  const routerActive = permissions.mode === 'policy-assess-human';
  const transient = permissions.transient_scope;
  if (!TRANSIENT_SCOPE_MODES.includes(transient.mode)) {
    errors.push(`supervision.permissions.transient_scope.mode must be one of: ${TRANSIENT_SCOPE_MODES.join(', ')}`);
  }
  requireBoundedInteger(transient.maximum_age_seconds, 'supervision.permissions.transient_scope.maximum_age_seconds', 5, 3600, errors);
  requireBoundedInteger(transient.maximum_entries, 'supervision.permissions.transient_scope.maximum_entries', 1, 500, errors);
  if (transient.mode !== 'disabled' && !routerActive) {
    errors.push("supervision.permissions.transient_scope.mode requires supervision.permissions.mode 'policy-assess-human'; the legacy envelope never projects a permission scope");
  }

  const policy = permissions.policy;
  if (!Number.isInteger(policy.version) || policy.version < 1) errors.push('supervision.permissions.policy.version must be a positive integer');
  if (!Array.isArray(policy.auto_operations)) errors.push('supervision.permissions.policy.auto_operations must be an array');
  else {
    for (const [index, operation] of policy.auto_operations.entries()) {
      const label = `supervision.permissions.policy.auto_operations[${index}]`;
      if (typeof operation !== 'string' || !operation.trim()) { errors.push(`${label} must be a non-empty operation name`); continue; }
      const normalizedOperation = normalizePermissionOperation(operation);
      if (!CANONICAL_OPERATION_SET.has(normalizedOperation)) errors.push(`${label} '${operation}' is not a known permission operation`);
      else if (!POLICY_AUTO_OPERATION_SET.has(normalizedOperation)) {
        errors.push(`${label} '${operation}' can never be mechanically proven low impact; allowed operations are ${POLICY_ELIGIBLE_AUTO_OPERATIONS.join(', ')}`);
      }
    }
  }
  if (!Array.isArray(policy.protected_paths)) errors.push('supervision.permissions.policy.protected_paths must be an array');
  else {
    for (const [index, entry] of policy.protected_paths.entries()) {
      const label = `supervision.permissions.policy.protected_paths[${index}]`;
      if (typeof entry !== 'string' || !entry.trim()) { errors.push(`${label} must be a non-empty project-relative path`); continue; }
      const value = entry.trim().replace(/\\/g, '/');
      if (/^(?:[A-Za-z]:|\/|\/\/)/.test(value)) errors.push(`${label} must be project-relative, not absolute`);
      if (value.split('/').includes('..')) errors.push(`${label} must not traverse outside the project`);
      if (/[*?]/.test(value)) errors.push(`${label} must be an exact path prefix, not a pattern`);
    }
  }
  if (!Array.isArray(policy.bash_rules)) errors.push('supervision.permissions.policy.bash_rules must be an array');
  else {
    for (const [index, rule] of policy.bash_rules.entries()) {
      errors.push(...validateBashRule(rule, `supervision.permissions.policy.bash_rules[${index}]`));
    }
  }
  if (!routerActive && (policy.auto_operations.length > 0 || (Array.isArray(policy.bash_rules) && policy.bash_rules.length > 0))) {
    errors.push("supervision.permissions.policy grants require supervision.permissions.mode 'policy-assess-human'");
  }

  const cache = permissions.decision_cache;
  requireBoolean(cache.enabled, 'supervision.permissions.decision_cache.enabled', errors);
  requireBoundedInteger(cache.maximum_entries, 'supervision.permissions.decision_cache.maximum_entries', 1, 1000, errors);
  requireBoundedInteger(cache.policy_ttl_seconds, 'supervision.permissions.decision_cache.policy_ttl_seconds', 1, 86_400, errors);
  requireBoundedInteger(cache.supervisor_ttl_seconds, 'supervision.permissions.decision_cache.supervisor_ttl_seconds', 1, 86_400, errors);
  requireBoundedInteger(cache.rejection_ttl_seconds, 'supervision.permissions.decision_cache.rejection_ttl_seconds', 1, 86_400, errors);
  if (cache.enabled === true && !routerActive) {
    errors.push("supervision.permissions.decision_cache.enabled requires supervision.permissions.mode 'policy-assess-human'");
  }
  if (Number.isInteger(cache.supervisor_ttl_seconds) && Number.isInteger(cache.policy_ttl_seconds) && cache.supervisor_ttl_seconds > cache.policy_ttl_seconds) {
    errors.push('supervision.permissions.decision_cache.supervisor_ttl_seconds must not exceed policy_ttl_seconds; a semantic judgment is shorter-lived than a mechanical one');
  }
}

/**
 * Normalize a validated configuration into the exact shape the router consumes.
 * Deterministic and side-effect free: the same input always yields the same
 * effective policy, and a version 1 document normalizes to the legacy envelope.
 */
export function normalizePermissionRouting(config) {
  const permissions = config?.permissions ?? DEFAULT_SUPERVISION_CONFIG.permissions;
  const mode = PERMISSION_ROUTING_MODES.includes(permissions.mode) ? permissions.mode : 'eligible-once-only';
  const routerActive = mode === 'policy-assess-human';
  const transient = { ...DEFAULT_SUPERVISION_CONFIG.permissions.transient_scope, ...(permissions.transient_scope ?? {}) };
  const policy = { ...DEFAULT_SUPERVISION_CONFIG.permissions.policy, ...(permissions.policy ?? {}) };
  const cache = { ...DEFAULT_SUPERVISION_CONFIG.permissions.decision_cache, ...(permissions.decision_cache ?? {}) };
  return {
    schema_version: SUPERVISION_CONFIG_VERSION,
    mode,
    router_active: routerActive,
    transient_scope: {
      enabled: routerActive && transient.mode === 'redacted-provider',
      mode: routerActive ? transient.mode : 'disabled',
      maximum_age_ms: transient.maximum_age_seconds * 1000,
      maximum_entries: transient.maximum_entries,
    },
    policy: {
      version: policy.version,
      auto_operations: routerActive ? [...policy.auto_operations].map(normalizePermissionOperation) : [],
      protected_paths: [...new Set([...DEFAULT_PROTECTED_PATH_SET, ...policy.protected_paths])],
      bash_rules: routerActive ? policy.bash_rules.map(rule => ({
        executable: String(rule.executable).trim().toLowerCase(),
        subcommand: rule.subcommand === null || rule.subcommand === undefined ? null : String(rule.subcommand).trim().toLowerCase(),
        allowed_flags: [...(rule.allowed_flags ?? [])],
        allow_paths: rule.allow_paths === true,
      })) : [],
    },
    decision_cache: {
      enabled: routerActive && cache.enabled === true,
      maximum_entries: cache.maximum_entries,
      policy_ttl_ms: cache.policy_ttl_seconds * 1000,
      supervisor_ttl_ms: cache.supervisor_ttl_seconds * 1000,
      rejection_ttl_ms: cache.rejection_ttl_seconds * 1000,
    },
  };
}

/**
 * Validate only the optional config object. Its absence is valid and means the
 * Markdown-only workflow remains the active product surface.
 */
export function validateSupervisionConfig(raw) {
  const errors = [];
  if (raw === undefined) {
    const config = structuredClone(DEFAULT_SUPERVISION_CONFIG);
    return { errors, config, configured: false, routing: normalizePermissionRouting(config) };
  }
  if (!isPlainObject(raw)) {
    return { errors: ['supervision must be an object when provided'], config: structuredClone(DEFAULT_SUPERVISION_CONFIG), configured: true, routing: null };
  }

  const config = merge(DEFAULT_SUPERVISION_CONFIG, raw);
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`supervision.${key} is not supported`);
  }
  requireBoolean(config.enabled, 'supervision.enabled', errors);

  for (const section of ['execution', 'supervisor', 'activation', 'permissions', 'budgets', 'recovery', 'notifications']) {
    if (!isPlainObject(config[section])) errors.push(`supervision.${section} must be an object`);
  }
  if (errors.length > 0) return { errors, config, configured: true, routing: null };
  for (const [section, allowed] of Object.entries(SECTION_KEYS)) {
    if (!isPlainObject(raw[section])) continue;
    for (const key of Object.keys(raw[section])) {
      if (!allowed.has(key)) errors.push(`supervision.${section}.${key} is not supported`);
    }
  }

  if (config.execution.adapter !== 'opencode') errors.push("supervision.execution.adapter must be 'opencode'");
  if (config.execution.transport !== 'server') errors.push("supervision.execution.transport must be 'server'");
  if (config.execution.launch !== 'attached-on-activation') {
    errors.push("supervision.execution.launch must be 'attached-on-activation'; managed mode is deferred");
  }

  if (config.supervisor.adapter !== 'opencode') errors.push("supervision.supervisor.adapter must be 'opencode'");
  requireBoolean(config.supervisor.enabled, 'supervision.supervisor.enabled', errors);
  requireBoolean(config.supervisor.required, 'supervision.supervisor.required', errors);
  requireString(config.supervisor.route, 'supervision.supervisor.route', errors);
  if (config.enabled) requireString(config.supervisor.model, 'supervision.supervisor.model', errors);
  if (config.enabled && (!config.supervisor.enabled || !config.supervisor.required)) {
    errors.push('supervision enabled requires a required supervisor model session');
  }

  if (config.activation.flag !== '--supervised') errors.push("supervision.activation.flag must be '--supervised'");
  if (config.activation.minimum_capability !== 'attached-live') {
    errors.push("supervision.activation.minimum_capability must be 'attached-live'");
  }
  if (config.activation.fail_closed !== true) errors.push('supervision.activation.fail_closed must be true');

  if (config.permissions.supervisor_decision !== 'eligible-once-only') {
    errors.push("supervision.permissions.supervisor_decision must be 'eligible-once-only'");
  }
  if (config.permissions.always !== 'human') errors.push("supervision.permissions.always must be 'human'");
  if (config.permissions.high_impact !== 'human') errors.push("supervision.permissions.high_impact must be 'human'");
  if (!Array.isArray(config.permissions.human_only) || config.permissions.human_only.some(value => !HUMAN_ONLY_PERMISSION_CATEGORIES.has(value))) {
    errors.push(`supervision.permissions.human_only must contain only: ${[...HUMAN_ONLY_PERMISSION_CATEGORIES].join(', ')}`);
  } else {
    const configuredHumanOnly = new Set(config.permissions.human_only);
    const missingHumanOnly = [...HUMAN_ONLY_PERMISSION_CATEGORIES].filter(value => !configuredHumanOnly.has(value));
    if (missingHumanOnly.length > 0) {
      errors.push(`supervision.permissions.human_only must include non-negotiable categories: ${missingHumanOnly.join(', ')}`);
    }
  }
  if (!Array.isArray(config.permissions.eligible_operations) || config.permissions.eligible_operations.some(value => typeof value !== 'string' || !value.trim())) {
    errors.push('supervision.permissions.eligible_operations must be an array of non-empty operation names');
  }
  if (!Array.isArray(config.permissions.eligible_bash_patterns) || config.permissions.eligible_bash_patterns.some(value => typeof value !== 'string' || !value.trim())) {
    errors.push('supervision.permissions.eligible_bash_patterns must be an array of non-empty command prefixes');
  }
  validatePermissionRouting(config.permissions, isPlainObject(raw.permissions) ? raw.permissions : null, errors);

  for (const [name, value] of Object.entries(config.budgets)) {
    if (!POSITIVE_BUDGETS.has(name)) {
      errors.push(`supervision.budgets.${name} is not supported`);
    } else if (!Number.isInteger(value) || value < 0) {
      errors.push(`supervision.budgets.${name} must be a non-negative integer`);
    }
  }
  for (const [name, value] of Object.entries(config.recovery)) {
    if (!Number.isInteger(value) || value < 0) errors.push(`supervision.recovery.${name} must be a non-negative integer`);
  }
  if (!Number.isInteger(config.notifications.history_limit) || config.notifications.history_limit < 1 || config.notifications.history_limit > 100) {
    errors.push('supervision.notifications.history_limit must be an integer between 1 and 100');
  }
  requireBoolean(config.notifications.native, 'supervision.notifications.native', errors);
  if (!Number.isInteger(config.notifications.approaching_threshold_percent)
    || config.notifications.approaching_threshold_percent < 1
    || config.notifications.approaching_threshold_percent > 100) {
    errors.push('supervision.notifications.approaching_threshold_percent must be an integer between 1 and 100');
  }
  if (!Array.isArray(config.fallback_routes)) {
    errors.push('supervision.fallback_routes must be an array');
  } else {
    for (const [index, route] of config.fallback_routes.entries()) {
      if (!isPlainObject(route) || route.adapter !== 'opencode' || typeof route.model !== 'string' || !route.model.trim()) {
        errors.push(`supervision.fallback_routes[${index}] must name an explicitly configured OpenCode model route`);
      }
    }
  }

  return { errors, config, configured: true, routing: errors.length === 0 ? normalizePermissionRouting(config) : null };
}

/**
 * One normalized lane-lease representation. Every lease value is stored and
 * consumed as `no_progress_ms` (milliseconds), so the field the controller
 * reads is exactly the field lane preparation writes.
 *
 * The attached MVP keeps a fixed 60-second observation tick; the lease is the
 * per-lane no-progress threshold evaluated on that tick, not a separate poll
 * interval. Accepted envelope spellings, in precedence order:
 * `lease.no_progress_ms`, `lease.no_progress_minutes`, `lease.ms`,
 * `lease.minutes`, a bare numeric `lease` (minutes), `no_progress_ms`.
 */
export const LANE_LEASE_BOUNDS = Object.freeze({ minimum_ms: 1_000, maximum_ms: 24 * 60 * 60_000 });

export function normalizeLaneLease(envelope, defaultNoProgressMs) {
  const lease = isPlainObject(envelope?.lease) ? envelope.lease : {};
  const candidates = [
    [lease.no_progress_ms, 1, 'lease.no_progress_ms'],
    [lease.no_progress_minutes, 60_000, 'lease.no_progress_minutes'],
    [lease.ms, 1, 'lease.ms'],
    [lease.minutes, 60_000, 'lease.minutes'],
    [typeof envelope?.lease === 'number' ? envelope.lease : undefined, 60_000, 'lease'],
    [envelope?.no_progress_ms, 1, 'no_progress_ms'],
  ];
  for (const [raw, multiplier, source] of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw) * multiplier;
    if (!Number.isFinite(value) || value < LANE_LEASE_BOUNDS.minimum_ms || value > LANE_LEASE_BOUNDS.maximum_ms) {
      return { no_progress_ms: defaultNoProgressMs, source: 'default', rejected: { source, reason: 'lease must be a positive duration inside the configured bounds' } };
    }
    return { no_progress_ms: Math.round(value), source };
  }
  return { no_progress_ms: defaultNoProgressMs, source: 'default' };
}

function compareVersionTuples(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Parse a stable semantic version. Build metadata is accepted and ignored;
 * a pre-release is deliberately rejected because `1.18.4-beta.1` precedes the
 * pinned `1.18.4` release and is not a substitute for it.
 */
export function parseStableSemanticVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(version ?? '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedOpencodeVersion(version) {
  const parsed = parseStableSemanticVersion(version);
  if (!parsed) return false;
  return compareVersionTuples(parsed, OPENCODE_VERSION_BOUNDS.minimum) >= 0
    && compareVersionTuples(parsed, OPENCODE_VERSION_BOUNDS.exclusive_maximum) < 0;
}
