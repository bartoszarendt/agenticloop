/**
 * Strict configuration for the optional supervision component. Keeping this
 * separate from normal adapter settings ensures an ordinary installation never
 * starts a controller or acquires runtime dependencies.
 */

export const SUPERVISION_CONFIG_VERSION = 1;

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
    supervisor_decision: 'eligible-once-only',
    always: 'human',
    high_impact: 'human',
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

/**
 * Validate only the optional config object. Its absence is valid and means the
 * Markdown-only workflow remains the active product surface.
 */
export function validateSupervisionConfig(raw) {
  const errors = [];
  if (raw === undefined) return { errors, config: structuredClone(DEFAULT_SUPERVISION_CONFIG), configured: false };
  if (!isPlainObject(raw)) {
    return { errors: ['supervision must be an object when provided'], config: structuredClone(DEFAULT_SUPERVISION_CONFIG), configured: true };
  }

  const config = merge(DEFAULT_SUPERVISION_CONFIG, raw);
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`supervision.${key} is not supported`);
  }
  requireBoolean(config.enabled, 'supervision.enabled', errors);

  for (const section of ['execution', 'supervisor', 'activation', 'permissions', 'budgets', 'recovery', 'notifications']) {
    if (!isPlainObject(config[section])) errors.push(`supervision.${section} must be an object`);
  }
  if (errors.length > 0) return { errors, config, configured: true };
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

  return { errors, config, configured: true };
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
