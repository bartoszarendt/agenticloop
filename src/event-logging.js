import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { loadAgenticLoopConfig } from './json.js';
import { isValidTaskId, loadProjectMap } from './project-map.js';
import {
  DELEGATION_MODES,
  FALLBACK_CAUSES,
  REVIEW_MODES,
  SINGLE_AGENT_FALLBACK,
  isValidDelegationMode,
  isValidFallbackCause,
  isValidReviewMode,
} from './review-provenance.js';
import { resolveTaskBackend } from './task-backend.js';

export const EVENT_SCHEMA_VERSION = 1;
export const DEFAULT_LOG_DIR = join('.agenticloop', 'logs');
export const STRICT_AUDIT_EVENT_TYPES = [
  'role.invoked',
  'task.started',
  'check.run',
  'review.result',
  'task.closed',
];

export const VALID_EVENT_TYPES = new Set([
  'task.created',
  'task.updated',
  'task.started',
  'role.invoked',
  'decision.recorded',
  'check.run',
  'artifact.linked',
  'review.started',
  'review.result',
  'blocked',
  'needs_context',
  'task.closed',
  'summary.published',
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

export const VALID_EVENT_BACKENDS = new Set(['files', 'github', 'unknown']);
export const VALID_EVENT_ROLES = new Set(['orchestrator', 'maintainer', 'engineer', 'supervisor', 'controller', 'operator', 'human', 'unknown']);
export const VALID_EVENT_OUTCOMES = new Set([
  'success',
  'failure',
  'blocked',
  'needs_context',
  'accepted',
  'needs_revision',
  'cancelled',
  'rejected',
  'exhausted',
  'unknown',
]);

const VALID_EVENT_OUTCOMES_BY_TYPE = new Map([
  ['task.created', ['unknown', 'success']],
  ['task.updated', ['unknown', 'success']],
  ['task.started', ['unknown', 'success']],
  ['role.invoked', ['unknown', 'success']],
  ['decision.recorded', ['unknown', 'success']],
  ['check.run', ['success', 'failure', 'blocked']],
  ['artifact.linked', ['unknown', 'success']],
  ['review.started', ['unknown', 'success']],
  ['review.result', ['accepted', 'needs_revision']],
  ['blocked', ['blocked']],
  ['needs_context', ['needs_context']],
  ['task.closed', ['success', 'failure', 'unknown']],
  ['summary.published', ['success', 'failure', 'unknown']],
  ['supervision.registered', ['success', 'failure', 'unknown']],
  ['supervision.assessed', ['success', 'failure', 'unknown']],
  ['supervision.reconciled', ['success', 'failure', 'unknown']],
  ['supervision.message', ['success', 'failure', 'unknown']],
  ['supervision.cancelled', ['cancelled', 'failure']],
  ['supervision.retried', ['success', 'failure', 'exhausted']],
  ['supervision.root_replaced', ['success', 'failure', 'exhausted']],
  ['supervision.permission_decided', ['success', 'rejected', 'failure']],
  ['supervision.terminated', ['success', 'failure', 'unknown']],
  ['supervision.exhausted', ['exhausted']],
]);

const VALID_TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'event_id',
  'occurred_at',
  'trace_id',
  'parent_event_id',
  'task_id',
  'scope',
  'run_id',
  'backend',
  'host',
  'role',
  'event_type',
  'summary',
  'outcome',
  'refs',
  'data',
]);

// Optional event scope. Historical and ordinary task events omit both keys and
// are treated as task-scoped. `scope: 'run'` is the narrow extension that lets
// the optional supervision controller record control-plane facts that belong to
// a run rather than to any single task.
export const VALID_EVENT_SCOPES = new Set(['task', 'run']);
export const RUN_SCOPED_EVENT_TYPES = new Set([
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
const RUN_SCOPED_EVENT_ROLES = new Set(['controller', 'supervisor', 'operator']);

const BANNED_PRIVACY_KEYS = new Set([
  'prompt',
  'response',
  'messages',
  'transcript',
  'tool_output',
  'raw_output',
]);

// Feature-adoption telemetry. Task-record knobs (minimalism, effort budgets,
// context-overflow risk, context-pressure calibration) live in the durable task
// record (GitHub issue / files task file). These optional event-data fields are a
// log-native mirror so adoption can be measured from JSONL without scraping the
// backend. The event log is the telemetry/audit stream, not the task contract.
// `data` stays free-form (normalizeData); these are conventions, not new schema.
export const FEATURE_TELEMETRY_VERSION = 1;
export const DEFAULT_ATTEMPT_BUDGET = 3;
export const DEFAULT_REVIEW_BUDGET = 3;
export const MINIMALISM_LEVELS = ['none', 'lite', 'full', 'ultra'];
export const CONTEXT_OVERFLOW_RISK_LEVELS = ['medium', 'high'];
// One verdict/reason line. Longer values are the caller dumping discovery output.
const CONTEXT_NOTE_WARN_LENGTH = 280;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SUMMARY_WARN_LENGTH = 300;
const SUMMARY_HARD_LIMIT = 4000;
const DATA_HARD_LIMIT = 16000;
const TRANSCRIPT_MARKER_PATTERN = /(?:^|\n)\s*(?:system|user|assistant|tool)\s*:/gim;
const JSONL_DECODER = new TextDecoder('utf-8', { fatal: true });
const UNSAFE_TASK_ID_CHAR_PATTERN = /[\\/:*?"<>|\x00-\x1f]/;
const TRAILING_DOT_OR_SPACE_PATTERN = /[. ]$/;
const WINDOWS_RESERVED_BASENAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DEFAULT_LOG_DIR_DISPLAY = DEFAULT_LOG_DIR.replaceAll('\\', '/');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableString(value) {
  const trimmed = asTrimmedString(value);
  return trimmed || null;
}

function normalizeNullableSummaryValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') return String(value);
  return normalizeNullableString(value);
}

function normalizeRefs(value) {
  if (Array.isArray(value)) {
    return value.map(entry => asTrimmedString(entry)).filter(Boolean);
  }
  const trimmed = asTrimmedString(value);
  return trimmed ? [trimmed] : [];
}

function normalizeData(value) {
  if (value === undefined || value === null) return {};
  return value;
}

function normalizeTimestamp(explicitOccurredAt, now) {
  if (explicitOccurredAt !== undefined && explicitOccurredAt !== null) {
    const explicit = asTrimmedString(explicitOccurredAt);
    return explicit || String(explicitOccurredAt);
  }

  if (typeof now === 'string') {
    const parsed = new Date(now);
    return Number.isNaN(parsed.valueOf()) ? now : parsed.toISOString();
  }

  if (now instanceof Date) {
    return now.toISOString();
  }

  return new Date().toISOString();
}

function uuidFromBytes(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function formatRequiredOutcomes(eventType, allowedOutcomes) {
  if (allowedOutcomes.length === 1) {
    return `event_type '${eventType}' requires outcome ${allowedOutcomes[0]}`;
  }

  if (allowedOutcomes.length === 2) {
    return `event_type '${eventType}' requires outcome ${allowedOutcomes[0]} or ${allowedOutcomes[1]}`;
  }

  return `event_type '${eventType}' requires outcome ${allowedOutcomes
    .slice(0, -1)
    .join(', ')}, or ${allowedOutcomes.at(-1)}`;
}

function jsonSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function looksLikeTranscriptDump(text) {
  if (typeof text !== 'string') return false;
  const markers = text.match(TRANSCRIPT_MARKER_PATTERN) ?? [];
  if (markers.length >= 2) return true;
  if (text.length >= 2000 && text.includes('```')) return true;
  if (text.length >= 2000 && /\b(?:prompt|assistant response|tool output|transcript)\b/i.test(text)) {
    return true;
  }
  return false;
}

function resolveTraceSeed(input, taskId) {
  if (!taskId) return null;

  const explicitTraceSeed = normalizeNullableString(input.trace_seed ?? input.traceSeed);
  if (explicitTraceSeed) return explicitTraceSeed;

  const target = normalizeNullableString(input.target);
  const traceTarget = target ? resolve(target) : process.cwd();
  return `agenticloop:event-trace:v1:${traceTarget}:${taskId}`;
}

export function deriveTraceId(seed) {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return uuidFromBytes(bytes);
}

function resolveTraceId(input, taskId) {
  const explicitTraceId = normalizeNullableString(input.trace_id ?? input.traceId);
  if (explicitTraceId) return explicitTraceId;

  const traceSeed = resolveTraceSeed(input, taskId);
  if (traceSeed) return deriveTraceId(traceSeed);

  return randomUUID();
}

function isValidUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isValidOccurredAt(value) {
  if (typeof value !== 'string' || !ISO_8601_UTC_PATTERN.test(value)) return false;
  return !Number.isNaN(new Date(value).valueOf());
}

function isWithinDirectory(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeEventLogTaskId(taskId) {
  return normalizeNullableString(taskId);
}

function unsafeTaskIdError(taskId) {
  const normalizedTaskId = normalizeEventLogTaskId(taskId);
  if (!normalizedTaskId) return null;

  if (
    normalizedTaskId === '.' ||
    normalizedTaskId === '..' ||
    normalizedTaskId.includes('..') ||
    UNSAFE_TASK_ID_CHAR_PATTERN.test(normalizedTaskId) ||
    TRAILING_DOT_OR_SPACE_PATTERN.test(normalizedTaskId) ||
    WINDOWS_RESERVED_BASENAME_PATTERN.test(normalizedTaskId)
  ) {
    return (
      `task_id '${normalizedTaskId}' is not safe for event log filenames; ` +
      "use a simple id without path separators, traversal, ':', trailing dots/spaces, or reserved filename characters"
    );
  }

  return null;
}

function eventLogFileName(taskId) {
  const normalizedTaskId = normalizeEventLogTaskId(taskId);
  if (!normalizedTaskId) {
    throw new Error('--task is required for default event logging output');
  }

  const taskIdError = unsafeTaskIdError(normalizedTaskId);
  if (taskIdError) throw new Error(taskIdError);
  return `${normalizedTaskId}.jsonl`;
}

function formatEventLogPathForDisplay(filePath, target) {
  if (!target) return filePath.replaceAll('\\', '/');

  const resolvedTarget = resolve(target);
  return isWithinDirectory(resolvedTarget, filePath)
    ? relative(resolvedTarget, filePath).replaceAll('\\', '/')
    : filePath.replaceAll('\\', '/');
}

function contextualizeEventLogMessage(filePath, target, message) {
  const displayPath = formatEventLogPathForDisplay(filePath, target);
  const lineMatch = /^Line (\d+):\s*(.*)$/.exec(message);
  if (lineMatch) {
    return `${displayPath} line ${lineMatch[1]}: ${lineMatch[2]}`;
  }
  return `${displayPath}: ${message}`;
}

function taskFilePath(repoRoot, taskId) {
  const projectMapResult = loadProjectMap(repoRoot);
  if (projectMapResult?.config?.task_file_template) {
    return join(repoRoot, projectMapResult.config.task_file_template.replaceAll('{taskId}', taskId));
  }

  try {
    const config = loadAgenticLoopConfig(join(repoRoot, 'agenticloop.json'));
    const taskDirectory = config.backends?.files?.taskDirectory ?? '.agenticloop/tasks';
    return join(repoRoot, taskDirectory, `${taskId}.md`);
  } catch {
    return join(repoRoot, '.agenticloop', 'tasks', `${taskId}.md`);
  }
}

function normalizeAuditRequiredEventTypes(requiredEventTypes) {
  const rawValues = Array.isArray(requiredEventTypes)
    ? requiredEventTypes
    : requiredEventTypes === undefined || requiredEventTypes === null
      ? STRICT_AUDIT_EVENT_TYPES
      : [requiredEventTypes];

  const normalized = [...new Set(rawValues.map(value => asTrimmedString(value)).filter(Boolean))];
  const invalid = normalized.filter(eventType => !VALID_EVENT_TYPES.has(eventType));
  if (invalid.length > 0) {
    throw new Error(`Unknown required event type(s): ${invalid.join(', ')}`);
  }

  return normalized;
}

function isExplicitTaskBackendSource(source) {
  return source === 'project.md' || source === 'agenticloop.json';
}

function incrementCount(map, key, amount = 1) {
  if (!key) return;
  const normalizedKey = String(key);
  map.set(normalizedKey, (map.get(normalizedKey) ?? 0) + amount);
}

function sortCountEntries(map) {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function compareSummaryValues(a, b) {
  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }
  return String(a).localeCompare(String(b));
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readNullableBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

// Forward gate: a task's events opt into feature telemetry by carrying
// `feature_telemetry_version`. Historical events without the marker are never
// held to the telemetry contract, so existing logs cannot start warning.
function isTelemetryEvent(event) {
  return isPlainObject(event?.data)
    && toFiniteNumber(event.data.feature_telemetry_version) !== null
    && toFiniteNumber(event.data.feature_telemetry_version) >= 1;
}

function formatDurationMilliseconds(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown';
  if (durationMs === 0) return '0s';
  if (durationMs < 1000) return `${durationMs}ms`;

  let remainingSeconds = Math.floor(durationMs / 1000);
  const units = [
    ['d', 24 * 60 * 60],
    ['h', 60 * 60],
    ['m', 60],
    ['s', 1],
  ];
  const parts = [];

  for (const [label, size] of units) {
    if (remainingSeconds < size) continue;
    const value = Math.floor(remainingSeconds / size);
    parts.push(`${value}${label}`);
    remainingSeconds -= value * size;
  }

  return parts.join(' ');
}

function findPrivacyKeyPaths(value, currentPath = 'data') {
  const matches = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      matches.push(...findPrivacyKeyPaths(entry, `${currentPath}[${index}]`));
    });
    return matches;
  }

  if (!isPlainObject(value)) return matches;

  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${currentPath}.${key}`;
    if (BANNED_PRIVACY_KEYS.has(key)) matches.push(nextPath);
    matches.push(...findPrivacyKeyPaths(entry, nextPath));
  }

  return matches;
}

function hasGithubTaskReference(event) {
  if (event?.backend === 'github') return true;
  if (!Array.isArray(event?.refs)) return false;

  return event.refs.some(ref => {
    const normalizedRef = asTrimmedString(ref);
    return /^github:(?:issue|pr):\d+$/i.test(normalizedRef);
  });
}

function splitRefStrings(refs) {
  const result = [];
  if (!Array.isArray(refs)) return result;

  for (const ref of refs) {
    const str = asTrimmedString(ref);
    if (!str) continue;
    for (const part of str.split(',')) {
      const trimmed = part.trim();
      if (trimmed) result.push(trimmed);
    }
  }

  return result;
}

function hasGithubIssueAndPrRefs(event) {
  const refs = splitRefStrings(event?.refs);
  const hasIssue = refs.some(ref => /^github:issue:\d+$/i.test(ref));
  const hasPr = refs.some(ref => /^github:pr:\d+$/i.test(ref));
  return { hasIssue, hasPr, refs };
}

function hasValidClosureException(event) {
  const exception = event?.data?.closure_exception;
  if (exception === undefined || exception === null) return false;
  if (typeof exception === 'string') return asTrimmedString(exception).length > 0;
  if (isPlainObject(exception)) {
    return asTrimmedString(exception.reason).length > 0;
  }
  return false;
}

function isGithubBackedTask(repoRoot, options = {}) {
  const backendResolution = resolveTaskBackend(repoRoot, options);
  return backendResolution.backend === 'github';
}

function isDurableTaskClosedEvent(event, repoRoot, options = {}) {
  if (event?.event_type !== 'task.closed') return false;
  if (event.outcome !== 'success') return false;
  if (!['maintainer', 'orchestrator'].includes(event.role)) return false;

  if (!isGithubBackedTask(repoRoot, options)) return true;

  const { hasIssue, hasPr } = hasGithubIssueAndPrRefs(event);
  if (hasIssue && hasPr) return true;
  if (hasValidClosureException(event)) return true;

  return false;
}

function findLastTaskClosedEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.event_type === 'task.closed') {
      return events[i];
    }
  }
  return null;
}

function validateTaskReference(event, repoRoot) {
  const errors = [];
  const warnings = [];

  if (!repoRoot || !event?.task_id) return { errors, warnings };

  const projectMapResult = loadProjectMap(repoRoot);
  if (projectMapResult?.config?.task_id_regex && !isValidTaskId(event.task_id, projectMapResult.config.task_id_regex)) {
    warnings.push(
      `task_id '${event.task_id}' does not match project.md task_id_regex '${projectMapResult.config.task_id_regex}'`
    );
  }

  const taskPath = taskFilePath(repoRoot, event.task_id);
  if (existsSync(taskPath)) return { errors, warnings };

  const relativeTaskPath = relative(repoRoot, taskPath).replace(/\\/g, '/');
  const backendResolution = resolveTaskBackend(repoRoot, { projectMapResult });
  const explicitBackend = isExplicitTaskBackendSource(backendResolution.source);
  const explicitlyFiles = explicitBackend && backendResolution.backend === 'files';
  const explicitlyGithub = explicitBackend && backendResolution.backend === 'github';

  const message = `task_id '${event.task_id}' has no local files task record at ${relativeTaskPath}`;
  if (explicitlyGithub) return { errors, warnings };
  if (!explicitBackend && hasGithubTaskReference(event)) return { errors, warnings };
  warnings.push(message);

  return { errors, warnings };
}

function parseEventLogEntries(filePath) {
  const buffer = readFileSync(filePath);
  const text = JSONL_DECODER.decode(buffer);
  const rawLines = text.split(/\r?\n/);
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();

  const errors = [];
  const entries = [];

  rawLines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === '') {
      errors.push(`Line ${lineNumber}: blank lines are not allowed in the event log`);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push(`Line ${lineNumber}: invalid JSON (${error.message})`);
      return;
    }

    if (!isPlainObject(parsed)) {
      errors.push(`Line ${lineNumber}: event log entries must be JSON objects`);
      return;
    }

    entries.push({ lineNumber, event: parsed });
  });

  return { entries, errors };
}

export function resolveEventLogPath(target, output, taskId = null) {
  const defaultLogDir = resolveLogDirectory(target);
  const resolvedPath = output
    ? (isAbsolute(output) ? output : resolve(output))
    : join(defaultLogDir, eventLogFileName(taskId));
  const warnings = [];

  if (output) {
    if (!isWithinDirectory(defaultLogDir, resolvedPath)) {
      warnings.push(
        `Event log output is outside target ${DEFAULT_LOG_DIR_DISPLAY}/: ${resolvedPath}. ` +
          'Use overrides only for tests or an explicit local exception.'
      );
    }
  }

  return { path: resolvedPath, warnings };
}

export function resolveLogDirectory(target) {
  const resolvedTarget = target ? resolve(target) : process.cwd();
  return join(resolvedTarget, DEFAULT_LOG_DIR);
}

// Run-scoped supervision control-plane logs live one level below the task logs
// so a run log can never collide with a task file name.
export const SUPERVISION_LOG_SUBDIR = 'supervision';

export function listEventLogFiles(target) {
  const directory = resolveLogDirectory(target);
  if (!existsSync(directory)) {
    return { directory, files: [] };
  }

  const files = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(directory, entry.name));

  const supervisionDirectory = join(directory, SUPERVISION_LOG_SUBDIR);
  if (existsSync(supervisionDirectory)) {
    files.push(
      ...readdirSync(supervisionDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => join(supervisionDirectory, entry.name))
    );
  }

  return { directory, files: files.sort((a, b) => a.localeCompare(b)) };
}

export function buildEvent(input = {}, now = new Date()) {
  const taskId = normalizeNullableString(input.task_id ?? input.taskId ?? input.task);
  const scope = normalizeNullableString(input.scope);
  const runId = normalizeNullableString(input.run_id ?? input.runId);

  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: normalizeNullableString(input.event_id ?? input.eventId) ?? randomUUID(),
    occurred_at: normalizeTimestamp(input.occurred_at ?? input.occurredAt, now),
    trace_id: resolveTraceId(input, taskId ?? (scope === 'run' ? runId : null)),
    parent_event_id: normalizeNullableString(input.parent_event_id ?? input.parentEventId),
    task_id: taskId,
    // Both keys stay absent unless a caller opts in, so existing producers and
    // historical logs keep their exact shape.
    ...(scope ? { scope } : {}),
    ...(scope === 'run' && runId ? { run_id: runId } : {}),
    backend: asTrimmedString(input.backend) || 'unknown',
    host: asTrimmedString(input.host) || 'unknown',
    role: asTrimmedString(input.role) || 'unknown',
    event_type: asTrimmedString(input.event_type ?? input.eventType),
    summary: asTrimmedString(input.summary),
    outcome: asTrimmedString(input.outcome) || 'unknown',
    refs: normalizeRefs(input.refs ?? input.ref),
    data: normalizeData(input.data),
  };
}

export function validateEvent(event, options = {}) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(event)) {
    return {
      errors: ['Event must be a JSON object'],
      warnings,
    };
  }

  for (const key of Object.keys(event)) {
    if (VALID_TOP_LEVEL_KEYS.has(key)) continue;
    if (BANNED_PRIVACY_KEYS.has(key)) {
      errors.push(`Event contains banned top-level key '${key}'`);
    } else {
      errors.push(`Event contains unsupported top-level key '${key}'`);
    }
  }

  if (event.schema_version !== EVENT_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${EVENT_SCHEMA_VERSION}`);
  }

  if (!isValidUuid(event.event_id)) {
    errors.push('event_id must be a UUID string');
  }

  if (!isValidOccurredAt(event.occurred_at)) {
    errors.push('occurred_at must be an ISO-8601 UTC timestamp');
  }

  if (!isValidUuid(event.trace_id)) {
    errors.push('trace_id must be a UUID string');
  }

  if (event.parent_event_id !== null && !isValidUuid(event.parent_event_id)) {
    errors.push('parent_event_id must be a UUID string or null');
  }

  if (event.task_id !== null && !asTrimmedString(event.task_id)) {
    errors.push('task_id must be a non-empty string or null');
  }

  const scope = event.scope === undefined ? 'task' : event.scope;
  if (!VALID_EVENT_SCOPES.has(scope)) {
    errors.push(`scope must be one of: ${[...VALID_EVENT_SCOPES].join(', ')}`);
  } else if (scope === 'run') {
    if (!asTrimmedString(event.run_id)) {
      errors.push('run-scoped events require a non-empty run_id');
    }
    if (event.task_id !== null && event.task_id !== undefined) {
      errors.push('run-scoped events must not carry a task_id; task-scoped work belongs in the task event log');
    }
    if (!RUN_SCOPED_EVENT_TYPES.has(event.event_type)) {
      errors.push(`run-scoped events must use an approved control-plane event_type: ${[...RUN_SCOPED_EVENT_TYPES].join(', ')}`);
    }
    if (!RUN_SCOPED_EVENT_ROLES.has(event.role)) {
      errors.push(`run-scoped events require controller, supervisor, or operator provenance (role is '${event.role}')`);
    }
  } else if (event.run_id !== undefined) {
    errors.push("run_id is only supported on run-scoped events (scope: 'run')");
  }

  const taskIdError = unsafeTaskIdError(event.task_id);
  if (taskIdError) {
    errors.push(taskIdError);
  }

  if (!VALID_EVENT_BACKENDS.has(event.backend)) {
    errors.push(`backend must be one of: ${[...VALID_EVENT_BACKENDS].join(', ')}`);
  }

  if (!asTrimmedString(event.host)) {
    errors.push('host must be a non-empty string');
  }

  if (!VALID_EVENT_ROLES.has(event.role)) {
    errors.push(`role must be one of: ${[...VALID_EVENT_ROLES].join(', ')}`);
  }

  if (!VALID_EVENT_TYPES.has(event.event_type)) {
    errors.push(`event_type must be one of: ${[...VALID_EVENT_TYPES].join(', ')}`);
  }

  if (!asTrimmedString(event.summary)) {
    errors.push('summary is required');
  } else {
    if (event.summary.length > SUMMARY_WARN_LENGTH) {
      warnings.push(`summary is longer than ${SUMMARY_WARN_LENGTH} characters; keep workflow-gate events concise`);
    }
    if (event.summary.length > SUMMARY_HARD_LIMIT) {
      errors.push('summary is too large for a durable workflow event');
    } else if (looksLikeTranscriptDump(event.summary)) {
      warnings.push('summary looks like a transcript or raw tool dump');
    }
  }

  if (!VALID_EVENT_OUTCOMES.has(event.outcome)) {
    errors.push(`outcome must be one of: ${[...VALID_EVENT_OUTCOMES].join(', ')}`);
  } else if (VALID_EVENT_TYPES.has(event.event_type)) {
    const allowedOutcomes = VALID_EVENT_OUTCOMES_BY_TYPE.get(event.event_type);
    if (allowedOutcomes && !allowedOutcomes.includes(event.outcome)) {
      errors.push(formatRequiredOutcomes(event.event_type, allowedOutcomes));
    }
  }

  if (!Array.isArray(event.refs)) {
    errors.push('refs must be an array of strings');
  } else if (event.refs.some(ref => !asTrimmedString(ref))) {
    errors.push('refs must contain only non-empty strings');
  }

  if (!isPlainObject(event.data)) {
    errors.push('data must be a JSON object');
  } else {
    const privacyKeyPaths = findPrivacyKeyPaths(event.data);
    for (const keyPath of privacyKeyPaths) {
      errors.push(`data contains banned privacy-sensitive key '${keyPath}'`);
    }

    const dataSize = jsonSize(event.data);
    if (!Number.isFinite(dataSize)) {
      errors.push('data must be JSON-serializable');
    } else if (dataSize > DATA_HARD_LIMIT) {
      errors.push('data is too large for a durable workflow event');
    } else if (dataSize > 4000 && looksLikeTranscriptDump(JSON.stringify(event.data, null, 2))) {
      errors.push('data looks like a transcript or raw tool dump');
    }

    // Forward-gated feature-telemetry checks: only fire when the event opts in via
    // feature_telemetry_version, so historical logs never start warning. Non-fatal.
    if (isTelemetryEvent(event)) {
      if (event.event_type === 'task.created'
        && normalizeNullableString(event.data.minimalism) === null) {
        warnings.push('feature-telemetry task.created is missing minimalism');
      }
      const contextNote = event.data.context_note;
      if (typeof contextNote === 'string') {
        if (contextNote.length > CONTEXT_NOTE_WARN_LENGTH) {
          warnings.push(
            `context_note is longer than ${CONTEXT_NOTE_WARN_LENGTH} characters; keep it to one verdict line`
          );
        } else if (looksLikeTranscriptDump(contextNote)) {
          warnings.push('context_note looks like a transcript or raw tool dump');
        }
      }
    }
  }

  if (!taskIdError) {
    const taskReference = validateTaskReference(event, options.target ? resolve(options.target) : null);
    errors.push(...taskReference.errors);
    warnings.push(...taskReference.warnings);
  }

  return { errors, warnings };
}

// Producer-side delegation roles a `role.invoked` event may target. The
// orchestrator delegates only to maintainer or engineer.
const DELEGATION_TARGET_ROLES = new Set(['maintainer', 'engineer']);

function isBoolean(value) {
  return value === true || value === false;
}

// Strict producer rules for a newly written `role.invoked` event. These are NOT
// applied to historical logs by the generic validator; they gate new writes so
// an incomplete or self-justifying delegation record cannot be appended.
function validateRoleInvokedProducer(event) {
  const errors = [];
  const data = isPlainObject(event.data) ? event.data : {};

  if (event.role !== 'orchestrator') {
    errors.push(
      `role.invoked must be emitted by the orchestrator (role is '${event.role}'); a role must not emit a self-invocation event`
    );
  }

  const targetRole = normalizeNullableString(data.target_role);
  if (!targetRole) {
    errors.push("role.invoked requires data.target_role");
  } else if (!DELEGATION_TARGET_ROLES.has(targetRole)) {
    errors.push(
      `role.invoked data.target_role must be one of: ${[...DELEGATION_TARGET_ROLES].join(', ')} (got '${targetRole}')`
    );
  }

  const delegationMode = normalizeNullableString(data.delegation_mode);
  if (!delegationMode) {
    errors.push('role.invoked requires data.delegation_mode');
  } else if (!isValidDelegationMode(delegationMode)) {
    errors.push(
      `role.invoked data.delegation_mode must be one of: ${DELEGATION_MODES.join(', ')} (got '${delegationMode}')`
    );
  }

  if (!isBoolean(data.fallback)) {
    errors.push('role.invoked requires a boolean data.fallback');
  }

  const hasFallbackCause = data.fallback_cause !== undefined && data.fallback_cause !== null;

  if (delegationMode === SINGLE_AGENT_FALLBACK) {
    if (data.fallback !== true) {
      errors.push("role.invoked with delegation_mode 'single_agent_fallback' requires data.fallback: true");
    }
    const cause = normalizeNullableString(data.fallback_cause);
    if (!cause) {
      errors.push(
        `role.invoked with delegation_mode 'single_agent_fallback' requires data.fallback_cause (one of: ${FALLBACK_CAUSES.join(', ')})`
      );
    } else if (!isValidFallbackCause(cause)) {
      errors.push(
        `role.invoked data.fallback_cause must be one of: ${FALLBACK_CAUSES.join(', ')} (got '${cause}'); "re-review requested" is not a fallback cause`
      );
    }
    if (!normalizeNullableString(data.reason)) {
      errors.push(
        "role.invoked with delegation_mode 'single_agent_fallback' requires a non-empty data.reason naming the mechanism checked and the concrete result"
      );
    }
  } else if (delegationMode && isValidDelegationMode(delegationMode)) {
    // Real delegation modes.
    if (data.fallback === true) {
      errors.push(
        `role.invoked with delegation_mode '${delegationMode}' requires data.fallback: false`
      );
    }
    if (hasFallbackCause) {
      errors.push(
        `role.invoked with delegation_mode '${delegationMode}' must not carry data.fallback_cause`
      );
    }
  }

  return errors;
}

// Strict producer rules for a newly written `review.result` event.
function validateReviewResultProducer(event) {
  const errors = [];
  const data = isPlainObject(event.data) ? event.data : {};

  if (event.role !== 'maintainer') {
    errors.push(
      `review.result must be emitted by the maintainer (role is '${event.role}')`
    );
  }

  const reviewMode = normalizeNullableString(data.review_mode);
  if (!reviewMode) {
    errors.push('review.result requires data.review_mode');
  } else if (!isValidReviewMode(reviewMode)) {
    errors.push(
      `review.result data.review_mode must be one of: ${REVIEW_MODES.join(', ')} (got '${reviewMode}')`
    );
  }

  if (normalizeNullableSummaryValue(data.review_round) === null) {
    errors.push('review.result requires data.review_round');
  }

  if (data.continuation_reason !== undefined && data.continuation_reason !== null) {
    if (typeof data.continuation_reason !== 'string' || !data.continuation_reason.trim()) {
      errors.push('review.result data.continuation_reason must be a non-empty string when present');
    }
  }

  if (data.maintainer_fixup !== undefined) {
    if (!isBoolean(data.maintainer_fixup)) {
      errors.push('review.result data.maintainer_fixup must be a boolean when present');
    } else if (data.maintainer_fixup === true) {
      if (reviewMode && reviewMode !== SINGLE_AGENT_FALLBACK) {
        errors.push(
          "review.result with data.maintainer_fixup: true requires review_mode 'single_agent_fallback'"
        );
      }
    }
  }

  return errors;
}

// Producer-strict validation used for every NEWLY written event. It layers
// event-specific requirements on top of the generic historical-compatible
// shape check. Historical logs are never held to these producer rules.
export function validateNewEvent(event, options = {}) {
  const base = validateEvent(event, options);
  const errors = [...base.errors];
  const warnings = [...base.warnings];

  if (isPlainObject(event)) {
    if (event.event_type === 'role.invoked') {
      errors.push(...validateRoleInvokedProducer(event));
    } else if (event.event_type === 'review.result') {
      errors.push(...validateReviewResultProducer(event));
    }
  }

  return { errors, warnings };
}

export function appendEventLog({ target, output, event, path, historical = false }) {
  // Every newly produced event passes strict producer validation before it is
  // appended, so direct callers cannot bypass the write-path gate. Tests that
  // deliberately simulate historical or hypothetical on-disk logs pass
  // `historical: true`.
  if (!historical) {
    const { errors } = validateNewEvent(event, { target });
    if (errors.length > 0) {
      throw new Error(`Refusing to append invalid event: ${errors.join('; ')}`);
    }
  }

  const eventLogPath = path ?? resolveEventLogPath(target, output, event?.task_id).path;
  mkdirSync(dirname(eventLogPath), { recursive: true });
  appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, 'utf-8');
  return eventLogPath;
}

export function loadEvents(filePath) {
  const { entries, errors } = parseEventLogEntries(filePath);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return entries.map(entry => entry.event);
}

function validateEventLogFileInternal(filePath, options = {}) {
  const errors = [];
  const warnings = [];

  if (!existsSync(filePath)) {
    return { exists: false, eventCount: 0, errors, warnings };
  }

  const target = options.target ? resolve(options.target) : null;
  if (target && !options.skipPathWarning) {
    const defaultLogDir = join(target, DEFAULT_LOG_DIR);
    if (!isWithinDirectory(defaultLogDir, filePath)) {
      warnings.push(
        `Event log path is outside target ${DEFAULT_LOG_DIR_DISPLAY}/: ${filePath}. ` +
          'Use overrides only for tests or an explicit local exception.'
      );
    }
  }

  let parsed;
  try {
    parsed = parseEventLogEntries(filePath);
  } catch (error) {
    errors.push(`Event log is not valid UTF-8: ${error.message}`);
    return { exists: true, eventCount: 0, errors, warnings };
  }

  errors.push(...parsed.errors);

  for (const entry of parsed.entries) {
    const result = validateEvent(entry.event, { target });
    for (const error of result.errors) {
      errors.push(`Line ${entry.lineNumber}: ${error}`);
    }
    for (const warning of result.warnings) {
      warnings.push(`Line ${entry.lineNumber}: ${warning}`);
    }
  }

  return {
    exists: true,
    eventCount: parsed.entries.length,
    errors,
    warnings,
  };
}

export function validateEventLogFile(filePath, options = {}) {
  const target = options.target ? resolve(options.target) : null;
  const result = validateEventLogFileInternal(filePath, { ...options, target, skipPathWarning: true });

  if (!result.exists) {
    return { ...result, errors: [], warnings: [] };
  }

  return {
    ...result,
    errors: result.errors.map(error => contextualizeEventLogMessage(filePath, target, error)),
    warnings: result.warnings.map(warning => contextualizeEventLogMessage(filePath, target, warning)),
  };
}

export function validateEventLogs(target) {
  const { directory, files } = listEventLogFiles(target);
  if (files.length === 0) {
    return {
      exists: false,
      directory,
      files: [],
      fileCount: 0,
      eventCount: 0,
      errors: [],
      warnings: [],
    };
  }

  const errors = [];
  const warnings = [];
  let eventCount = 0;

  for (const filePath of files) {
    const result = validateEventLogFile(filePath, { target });
    eventCount += result.eventCount;
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    exists: true,
    directory,
    files,
    fileCount: files.length,
    eventCount,
    errors,
    warnings,
  };
}

function evaluateDurableClosure(events, repoRoot, options = {}) {
  const lastClosure = findLastTaskClosedEvent(events);
  if (!lastClosure) {
    return { satisfied: false, reason: 'no task.closed event recorded' };
  }

  if (isDurableTaskClosedEvent(lastClosure, repoRoot, options)) {
    return { satisfied: true };
  }

  const reasons = [];
  if (lastClosure.outcome !== 'success') {
    reasons.push(`outcome was ${lastClosure.outcome}`);
  }
  if (!['maintainer', 'orchestrator'].includes(lastClosure.role)) {
    reasons.push(`role was ${lastClosure.role}`);
  }
  if (isGithubBackedTask(repoRoot, options)) {
    const { hasIssue, hasPr } = hasGithubIssueAndPrRefs(lastClosure);
    if (!hasIssue && !hasPr) {
      reasons.push('missing github:issue and github:pr refs');
    } else if (!hasIssue) {
      reasons.push('missing github:issue ref');
    } else if (!hasPr) {
      reasons.push('missing github:pr ref');
    }
    if (!hasValidClosureException(lastClosure)) {
      reasons.push('no closure_exception');
    }
  }

  return { satisfied: false, reason: reasons.join(', ') || 'not a durable closure event' };
}

export function auditTaskEventLog({ target, taskId, requiredEventTypes, explicitRequire = false } = {}) {
  const resolvedTarget = target ? resolve(target) : process.cwd();
  const normalizedTaskId = normalizeNullableString(taskId);
  if (!normalizedTaskId) {
    throw new Error('taskId is required for event log audit');
  }

  const normalizedRequiredEventTypes = normalizeAuditRequiredEventTypes(requiredEventTypes);
  const projectMapResult = loadProjectMap(resolvedTarget);
  const eventLogging = projectMapResult?.config?.event_logging ?? 'disabled';
  const eventLogPath = resolveEventLogPath(resolvedTarget, undefined, normalizedTaskId).path;
  const displayPath = formatEventLogPathForDisplay(eventLogPath, resolvedTarget);
  const requiresTaskClosed = normalizedRequiredEventTypes.includes('task.closed');
  const result = {
    taskId: normalizedTaskId,
    eventLogging,
    enabled: eventLogging === 'enabled',
    explicitRequire: Boolean(explicitRequire),
    requiredEventTypes: normalizedRequiredEventTypes,
    path: eventLogPath,
    displayPath,
    exists: false,
    eventCount: 0,
    missingEventTypes: [],
    durableClosure: requiresTaskClosed ? { satisfied: false, reason: 'not evaluated' } : undefined,
    errors: [],
    warnings: [],
    skipped: false,
    ok: true,
  };

  if (!result.enabled && !result.explicitRequire) {
    result.skipped = true;
    return result;
  }

  const validation = validateEventLogFile(eventLogPath, { target: resolvedTarget });
  result.exists = validation.exists;
  result.eventCount = validation.eventCount;
  result.errors.push(...validation.errors);
  result.warnings.push(...validation.warnings);

  if (!validation.exists) {
    result.errors.push(`Missing task event log: ${displayPath}`);
    result.ok = false;
    return result;
  }

  if (validation.eventCount === 0) {
    result.errors.push(`Task event log has zero events: ${displayPath}`);
    result.ok = false;
    return result;
  }

  if (result.errors.length === 0) {
    const events = loadEvents(eventLogPath);
    const recordedEventTypes = new Set(events.map(event => event.event_type));
    result.missingEventTypes = normalizedRequiredEventTypes.filter(
      eventType => !recordedEventTypes.has(eventType)
    );
    if (result.missingEventTypes.length > 0) {
      result.errors.push(`Missing required event types: ${result.missingEventTypes.join(', ')}`);
    }

    if (requiresTaskClosed && result.missingEventTypes.length === 0) {
      const durableClosure = evaluateDurableClosure(events, resolvedTarget, { projectMapResult });
      result.durableClosure = durableClosure;
      if (!durableClosure.satisfied) {
        result.errors.push(`Durable task.closed not satisfied: ${durableClosure.reason}`);
      }
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

/**
 * Per-review backing correlation for maintainer review rounds (telemetry only,
 * never fatal for historical logs). Each `review.result` is evaluated
 * independently against the task's ordered event stream: it is backed when it
 * carries a non-empty `continuation_reason`, or when an unconsumed
 * `role.invoked` targeting maintainer precedes it within the current review
 * step. Invocation evidence is consumed (one invocation backs at most one
 * review) and scoped (leftover invocations do not carry past a `review.result`,
 * and an invocation followed by `task.created` before any `review.started` is
 * treated as planning delegation, not review backing). When both the invocation
 * and the review carry `review_round` values, they must match. Exact
 * correlation is impossible for some legacy streams, so the round/planning
 * scoping is a conservative heuristic; out-of-order or malformed events are
 * still counted without crashing.
 *
 * @param {Array<any>} events Ordered task event stream.
 * @returns {number} review.result events with neither backing nor continuation.
 */
function countReviewRoundsWithoutBacking(events) {
  let gaps = 0;
  /** @type {Array<{ round: number|null, sawReviewStarted: boolean }>} */
  let pending = [];

  for (const event of events) {
    const type = event?.event_type;

    if (type === 'role.invoked') {
      if (normalizeNullableString(event.data?.target_role) === 'maintainer') {
        pending.push({ round: toFiniteNumber(event.data?.review_round), sawReviewStarted: false });
      }
      continue;
    }

    if (type === 'task.created') {
      // A maintainer invocation that leads straight into task creation was a
      // planning delegation; it must not mask a later unbacked review round.
      pending = pending.filter(token => token.sawReviewStarted);
      continue;
    }

    if (type === 'review.started') {
      const round = toFiniteNumber(event.data?.review_round);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (!pending[i].sawReviewStarted) {
          pending[i].sawReviewStarted = true;
          if (pending[i].round === null) pending[i].round = round;
          break;
        }
      }
      continue;
    }

    if (type === 'review.result') {
      // Only maintainer review results participate in maintainer-delegation
      // correlation. Malformed historical results from other roles are reported
      // by a separate provenance-quality counter and must not create a false
      // "unbacked maintainer review" gap or consume maintainer evidence.
      if (event?.role !== 'maintainer') continue;
      const round = toFiniteNumber(event.data?.review_round);
      const hasContinuation = Boolean(normalizeNullableString(event.data?.continuation_reason));
      if (!hasContinuation) {
        let matched = -1;
        for (let i = pending.length - 1; i >= 0; i--) {
          const tokenRound = pending[i].round;
          if (tokenRound === null || round === null || tokenRound === round) {
            matched = i;
            break;
          }
        }
        if (matched >= 0) pending.splice(matched, 1);
        else gaps += 1;
      }
      // Invocation evidence is scoped to the review step it precedes; an
      // earlier-round leftover cannot back a later round.
      pending = [];
    }
  }

  return gaps;
}

function summarizeEvents(events, repoRoot) {
  const recordedEventTypes = new Set(events.map(event => event.event_type));
  const strictAudit = {
    requiredEventTypes: [...STRICT_AUDIT_EVENT_TYPES],
    presentEventTypes: STRICT_AUDIT_EVENT_TYPES.filter(eventType => recordedEventTypes.has(eventType)),
    missingEventTypes: STRICT_AUDIT_EVENT_TYPES.filter(eventType => !recordedEventTypes.has(eventType)),
    durableClosure: evaluateDurableClosure(events, repoRoot),
  };

  const checkRunCounts = { success: 0, failure: 0, blocked: 0 };
  const failedOrBlockedChecks = [];
  const acceptedImperfectChecks = [];
  const reviewResultCounts = { accepted: 0, needs_revision: 0 };
  const reviewRoundValues = new Set();
  const targetRoleCounts = new Map();
  const delegationModeCounts = new Map();
  const refsSummary = new Map();
  let fallbackCount = 0;

  // Provenance-quality (telemetry-only) counters. These never fail historical
  // logs; they surface incomplete or inconsistent delegation/review provenance
  // as report metrics. Historical events are labeled, never rewritten.
  const provenanceQuality = {
    roleInvokedMissingTargetRole: 0,
    roleInvokedMissingDelegationMode: 0,
    roleInvokedMissingFallback: 0,
    roleInvokedFallbackWithoutCause: 0,
    roleInvokedInconsistentModeFallback: 0,
    roleInvokedNonOrchestrator: 0,
    roleInvokedSelfInvocation: 0,
    reviewResultMissingReviewMode: 0,
    reviewResultNonMaintainer: 0,
    reviewRoundsWithoutBacking: 0,
    maintainerFixupEvents: 0,
  };
  let firstTimestampMs = Number.POSITIVE_INFINITY;
  let lastTimestampMs = Number.NEGATIVE_INFINITY;
  let firstEventTimestamp = null;
  let lastEventTimestamp = null;

  for (const event of events) {
    const timestampMs = new Date(event.occurred_at).valueOf();
    if (timestampMs < firstTimestampMs) {
      firstTimestampMs = timestampMs;
      firstEventTimestamp = event.occurred_at;
    }
    if (timestampMs > lastTimestampMs) {
      lastTimestampMs = timestampMs;
      lastEventTimestamp = event.occurred_at;
    }

    for (const ref of event.refs) {
      incrementCount(refsSummary, ref);
    }

    const reviewRound = normalizeNullableSummaryValue(event.data?.review_round);
    if (reviewRound) reviewRoundValues.add(reviewRound);

    if (event.event_type === 'check.run') {
      const triagedUnrelated = event.data?.triaged_unrelated === true;
      const acceptedKnownFailure = event.data?.accepted_known_failure === true;
      const acceptedImperfect = triagedUnrelated || acceptedKnownFailure;

      if (event.outcome === 'success' || event.outcome === 'failure' || event.outcome === 'blocked') {
        checkRunCounts[event.outcome] += 1;
      }

      if (acceptedImperfect) {
        acceptedImperfectChecks.push({
          occurred_at: event.occurred_at,
          outcome: event.outcome,
          summary: event.summary,
          refs: [...event.refs],
          command: normalizeNullableString(event.data?.command),
          triaged_unrelated: triagedUnrelated,
          accepted_known_failure: acceptedKnownFailure,
          required: event.data?.required === true,
        });
      } else if (event.outcome === 'failure' || event.outcome === 'blocked') {
        failedOrBlockedChecks.push({
          occurred_at: event.occurred_at,
          outcome: event.outcome,
          summary: event.summary,
          refs: [...event.refs],
          command: normalizeNullableString(event.data?.command),
        });
      }
      continue;
    }

    if (event.event_type === 'review.result') {
      if (event.outcome === 'accepted' || event.outcome === 'needs_revision') {
        reviewResultCounts[event.outcome] += 1;
      }
      const reviewMode = normalizeNullableString(event.data?.review_mode);
      if (!reviewMode) provenanceQuality.reviewResultMissingReviewMode += 1;
      if (event.role !== 'maintainer') provenanceQuality.reviewResultNonMaintainer += 1;
      if (event.data?.maintainer_fixup === true) provenanceQuality.maintainerFixupEvents += 1;
      continue;
    }

    if (event.event_type === 'role.invoked') {
      const targetRole = normalizeNullableString(event.data?.target_role);
      if (targetRole) incrementCount(targetRoleCounts, targetRole);

      const delegationMode = normalizeNullableString(event.data?.delegation_mode);
      if (delegationMode) incrementCount(delegationModeCounts, delegationMode);

      if (event.data?.fallback === true) {
        fallbackCount += 1;
      }

      // Provenance-quality checks (telemetry, never fatal for historical logs).
      if (!targetRole) provenanceQuality.roleInvokedMissingTargetRole += 1;
      if (!delegationMode) provenanceQuality.roleInvokedMissingDelegationMode += 1;
      // Strict type semantics: only actual booleans count. A string "true" is a
      // historical provenance-quality gap, reported but never rewritten.
      if (typeof event.data?.fallback !== 'boolean') {
        provenanceQuality.roleInvokedMissingFallback += 1;
      }
      if (event.role !== 'orchestrator') provenanceQuality.roleInvokedNonOrchestrator += 1;
      if (targetRole && event.role !== 'unknown' && targetRole === event.role
        && (event.role === 'maintainer' || event.role === 'engineer')) {
        provenanceQuality.roleInvokedSelfInvocation += 1;
      }

      const fallbackCause = normalizeNullableString(event.data?.fallback_cause);
      if (delegationMode === 'single_agent_fallback') {
        if (!fallbackCause) provenanceQuality.roleInvokedFallbackWithoutCause += 1;
        if (event.data?.fallback !== true) provenanceQuality.roleInvokedInconsistentModeFallback += 1;
      } else if (delegationMode && isValidDelegationMode(delegationMode)) {
        if (event.data?.fallback === true || fallbackCause) {
          provenanceQuality.roleInvokedInconsistentModeFallback += 1;
        }
      }
    }
  }

  // A maintainer review round should be backed by a correlated delegation
  // (role.invoked targeting maintainer for that review step) or carry an
  // explicit continuation reason. Each review.result is evaluated independently
  // through ordered per-review correlation -- never aggregate subtraction, so an
  // unrelated maintainer invocation cannot mask an unbacked review round.
  provenanceQuality.reviewRoundsWithoutBacking = countReviewRoundsWithoutBacking(events);

  const traceDurationMs = events.length > 0 ? Math.max(0, lastTimestampMs - firstTimestampMs) : 0;

  return {
    eventCount: events.length,
    firstEventTimestamp,
    lastEventTimestamp,
    traceDurationMs,
    traceDuration: formatDurationMilliseconds(traceDurationMs),
    strictAudit,
    checkRunCounts,
    acceptedImperfectChecks,
    failedOrBlockedChecks,
    reviewResultCounts,
    reviewRounds: [...reviewRoundValues].sort(compareSummaryValues),
    roleInvoked: {
      total: events.filter(event => event.event_type === 'role.invoked').length,
      targetRoleCounts: sortCountEntries(targetRoleCounts),
      delegationModeCounts: sortCountEntries(delegationModeCounts),
      fallbackCount,
    },
    provenanceQuality: {
      ...provenanceQuality,
      hasFixup: provenanceQuality.maintainerFixupEvents >= 1,
      multipleFixupEpisodes: provenanceQuality.maintainerFixupEvents > 1,
    },
    refsSummary: sortCountEntries(refsSummary).map(entry => ({ ref: entry.value, count: entry.count })),
  };
}

// Per-task feature-adoption view. Review-round dimension is derived from events
// that already exist (review.result count, data.review_round, and the closeout
// data.review_rounds total), so it works on
// historical logs with no producer changes. The knob fields (minimalism, budgets,
// context risk/pressure) are read from emitted telemetry when present.
function summarizeTaskFeatures(events) {
  const created = events.find(event => event.event_type === 'task.created') ?? null;
  let closed = null;
  for (const event of events) {
    if (event.event_type === 'task.closed') closed = event; // last one wins
  }

  const reviewResultEvents = events.filter(event => event.event_type === 'review.result');
  const reviewResultCount = reviewResultEvents.length;
  const needsRevisionCount = reviewResultEvents.filter(event => event.outcome === 'needs_revision').length;
  const acceptedCount = reviewResultEvents.filter(event => event.outcome === 'accepted').length;

  let maxExplicitReviewRound = 0;
  for (const event of events) {
    // Per-review round number (review.started/review.result) and the closeout
    // total (task.closed data.review_rounds) are both explicit round signals.
    const round = toFiniteNumber(event.data?.review_round);
    if (round !== null && round > maxExplicitReviewRound) maxExplicitReviewRound = round;
    const rounds = toFiniteNumber(event.data?.review_rounds);
    if (rounds !== null && rounds > maxExplicitReviewRound) maxExplicitReviewRound = rounds;
  }
  const derivedReviewRounds = Math.max(maxExplicitReviewRound, reviewResultCount);

  const reviewBudgetExplicit = toFiniteNumber(closed?.data?.review_budget)
    ?? toFiniteNumber(created?.data?.review_budget);
  const reviewBudget = reviewBudgetExplicit ?? DEFAULT_REVIEW_BUDGET;
  const reviewBudgetIsDefault = reviewBudgetExplicit === null;
  const overReviewBudget = derivedReviewRounds > reviewBudget || needsRevisionCount >= reviewBudget;

  const attemptBudget = toFiniteNumber(created?.data?.attempt_budget);
  const minimalism = normalizeNullableString(created?.data?.minimalism);
  const minimalismTrigger = normalizeNullableString(created?.data?.minimalism_trigger);
  const contextOverflowRisk = normalizeNullableString(created?.data?.context_overflow_risk)
    ?? normalizeNullableString(closed?.data?.context_overflow_risk);
  const contextPressureEncountered = readNullableBoolean(closed?.data?.context_pressure_encountered);
  const reviewBudgetExceededRecorded = readNullableBoolean(closed?.data?.review_budget_exceeded);

  // Durable Maintainer Review Fixup episodes are counted only from explicit
  // review.result data.maintainer_fixup: true. A same-session review mode alone
  // is not a fixup.
  const maintainerFixupEpisodes = reviewResultEvents.filter(
    event => event.data?.maintainer_fixup === true
  ).length;

  return {
    hasTelemetry: events.some(isTelemetryEvent),
    hasCreated: created !== null,
    hasClosed: closed !== null,
    reviewResultCount,
    needsRevisionCount,
    acceptedCount,
    maxExplicitReviewRound,
    derivedReviewRounds,
    reviewBudget,
    reviewBudgetIsDefault,
    overReviewBudget,
    reviewBudgetExceededRecorded,
    attemptBudget,
    minimalism,
    minimalismTrigger,
    contextOverflowRisk,
    contextPressureEncountered,
    maintainerFixupEpisodes,
  };
}

export function reportTaskEventLog({ target, taskId } = {}) {
  const resolvedTarget = target ? resolve(target) : process.cwd();
  const normalizedTaskId = normalizeNullableString(taskId);
  if (!normalizedTaskId) {
    throw new Error('taskId is required for event log report');
  }

  const eventLogPath = resolveEventLogPath(resolvedTarget, undefined, normalizedTaskId).path;
  const displayPath = formatEventLogPathForDisplay(eventLogPath, resolvedTarget);
  const validation = validateEventLogFile(eventLogPath, { target: resolvedTarget });
  if (!validation.exists) {
    throw new Error(`Missing task event log: ${displayPath}`);
  }
  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join('; '));
  }

  const events = loadEvents(eventLogPath);
  const summary = summarizeEvents(events, resolvedTarget);

  return {
    taskId: normalizedTaskId,
    path: eventLogPath,
    displayPath,
    ...summary,
    warnings: [...validation.warnings],
  };
}

function createEmptyFeatureAggregate() {
  return {
    telemetryVersion: FEATURE_TELEMETRY_VERSION,
    tasksScanned: 0,
    tasksWithTelemetry: 0,
    reviewRounds: {
      maxDerivedReviewRounds: 0,
      tasksOverBudget: [],
      churnTasks: [],
    },
    minimalism: { none: 0, lite: 0, full: 0, ultra: 0, missing: 0, other: 0 },
    minimalismTriggers: [],
    budgets: {
      nonDefaultAttempt: [],
      nonDefaultReview: [],
    },
    contextOverflowRisk: { medium: 0, high: 0, tasks: [] },
    contextPressure: { true: 0, false: 0, missingForRiskTasks: [] },
    omissionCandidates: {
      contextRiskPressureNoPredict: [], // Rule 1: taskIds
      contextRiskOverBudgetNoPredict: [], // Rule 2: {taskId, derivedReviewRounds, reviewBudget}
    },
    // Maintainer Review Fixup observability (from durable maintainer_fixup: true
    // review.result events). A fallback review mode alone does not count as a
    // fixup; only the explicit event flag does.
    maintainerFixup: {
      episodeCount: 0, // total maintainer_fixup: true events across tasks
      tasksWithFixup: [], // taskIds with at least one fixup
      tasksWithMultipleFixups: [], // taskIds with more than one recorded episode
    },
    warnings: [],
  };
}

// Telemetry-quality provenance metrics surfaced by the aggregate report. Each
// carries a running count and the task ids that contributed. These are
// telemetry, not workflow failures: historical incomplete events are labeled
// here, never rewritten or backfilled.
const PROVENANCE_QUALITY_METRICS = [
  'roleInvokedMissingTargetRole',
  'roleInvokedMissingDelegationMode',
  'roleInvokedMissingFallback',
  'roleInvokedFallbackWithoutCause',
  'roleInvokedInconsistentModeFallback',
  'roleInvokedNonOrchestrator',
  'roleInvokedSelfInvocation',
  'reviewResultMissingReviewMode',
  'reviewResultNonMaintainer',
  'reviewRoundsWithoutBacking',
];

function createEmptyProvenanceQualityAggregate() {
  const aggregate = {};
  for (const metric of PROVENANCE_QUALITY_METRICS) {
    aggregate[metric] = { count: 0, tasks: [] };
  }
  return aggregate;
}

function accumulateProvenanceQuality(aggregate, taskId, taskProvenanceQuality) {
  for (const metric of PROVENANCE_QUALITY_METRICS) {
    const count = taskProvenanceQuality?.[metric] ?? 0;
    if (count > 0) {
      aggregate[metric].count += count;
      aggregate[metric].tasks.push(taskId);
    }
  }
}

function finalizeProvenanceQualityAggregate(aggregate) {
  for (const metric of PROVENANCE_QUALITY_METRICS) {
    aggregate[metric].tasks.sort((a, b) => String(a).localeCompare(String(b)));
  }
}

function accumulateTaskFeatures(features, triggerCounts, taskId, taskFeatures) {
  features.tasksScanned += 1;
  if (taskFeatures.hasTelemetry) features.tasksWithTelemetry += 1;

  // Review-round dimension: derived from existing events, applies to every task.
  features.reviewRounds.maxDerivedReviewRounds = Math.max(
    features.reviewRounds.maxDerivedReviewRounds,
    taskFeatures.derivedReviewRounds
  );
  if (taskFeatures.overReviewBudget) {
    features.reviewRounds.tasksOverBudget.push(taskId);
  }
  if (taskFeatures.derivedReviewRounds > 1 || taskFeatures.needsRevisionCount > 0) {
    features.reviewRounds.churnTasks.push({
      taskId,
      derivedReviewRounds: taskFeatures.derivedReviewRounds,
      needsRevisionCount: taskFeatures.needsRevisionCount,
      acceptedCount: taskFeatures.acceptedCount,
      reviewBudget: taskFeatures.reviewBudget,
      reviewBudgetIsDefault: taskFeatures.reviewBudgetIsDefault,
      overBudget: taskFeatures.overReviewBudget,
    });
  }

  // Maintainer Review Fixup observability: episodes come only from explicit
  // maintainer_fixup: true events, applies to every task (not gated on the
  // telemetry marker) since the fixup flag is itself the durable signal.
  if (taskFeatures.maintainerFixupEpisodes > 0) {
    features.maintainerFixup.episodeCount += taskFeatures.maintainerFixupEpisodes;
    features.maintainerFixup.tasksWithFixup.push(taskId);
    if (taskFeatures.maintainerFixupEpisodes > 1) {
      features.maintainerFixup.tasksWithMultipleFixups.push(taskId);
    }
  }

  // Emitted-telemetry dimensions: only count tasks that opted into telemetry so
  // historical tasks are not miscounted as "minimalism missing".
  if (taskFeatures.hasTelemetry && taskFeatures.hasCreated) {
    if (taskFeatures.minimalism === null) {
      features.minimalism.missing += 1;
    } else if (MINIMALISM_LEVELS.includes(taskFeatures.minimalism)) {
      features.minimalism[taskFeatures.minimalism] += 1;
    } else {
      features.minimalism.other += 1;
    }
    if (taskFeatures.minimalismTrigger) incrementCount(triggerCounts, taskFeatures.minimalismTrigger);
  }

  if (taskFeatures.attemptBudget !== null && taskFeatures.attemptBudget !== DEFAULT_ATTEMPT_BUDGET) {
    features.budgets.nonDefaultAttempt.push({ taskId, attemptBudget: taskFeatures.attemptBudget });
  }
  if (!taskFeatures.reviewBudgetIsDefault && taskFeatures.reviewBudget !== DEFAULT_REVIEW_BUDGET) {
    features.budgets.nonDefaultReview.push({ taskId, reviewBudget: taskFeatures.reviewBudget });
  }

  if (taskFeatures.contextOverflowRisk === 'medium' || taskFeatures.contextOverflowRisk === 'high') {
    features.contextOverflowRisk[taskFeatures.contextOverflowRisk] += 1;
    features.contextOverflowRisk.tasks.push(taskId);
    if (taskFeatures.contextPressureEncountered === true) {
      features.contextPressure.true += 1;
    } else if (taskFeatures.contextPressureEncountered === false) {
      features.contextPressure.false += 1;
    } else {
      features.contextPressure.missingForRiskTasks.push(taskId);
    }
  }

  // Context-risk omission candidates (report-only heuristic, NOT warnings).
  // Forward-gated to telemetry tasks. "Candidate", not "missed": heuristic signal.
  // Rule 1 = higher-confidence candidate (pressure hit, no risk predicted).
  // Rule 2 = lower-confidence candidate (budget reached/exceeded, no risk,
  // no confirmed pressure so Rule 1 does not own it).
  if (taskFeatures.hasTelemetry) {
    const riskPredicted = taskFeatures.contextOverflowRisk === 'medium'
      || taskFeatures.contextOverflowRisk === 'high';
    if (!riskPredicted && taskFeatures.contextPressureEncountered === true) {
      features.omissionCandidates.contextRiskPressureNoPredict.push(taskId);
    } else if (!riskPredicted && taskFeatures.overReviewBudget) {
      features.omissionCandidates.contextRiskOverBudgetNoPredict.push({
        taskId,
        derivedReviewRounds: taskFeatures.derivedReviewRounds,
        reviewBudget: taskFeatures.reviewBudget,
      });
    }
  }

  // Task-level telemetry warnings are forward-gated: only telemetry tasks.
  if (taskFeatures.hasTelemetry) {
    const risk = taskFeatures.contextOverflowRisk;
    if ((risk === 'medium' || risk === 'high') && taskFeatures.contextPressureEncountered === null) {
      features.warnings.push(
        `${taskId}: context_overflow_risk '${risk}' set but closeout records no context_pressure_encountered`
      );
    }
    if (taskFeatures.overReviewBudget) {
      if (taskFeatures.reviewBudgetExceededRecorded !== true) {
        const found = taskFeatures.reviewBudgetExceededRecorded === false ? 'false' : 'missing';
        features.warnings.push(
          `${taskId}: review rounds (${taskFeatures.derivedReviewRounds}) exceed budget (${taskFeatures.reviewBudget}) but closeout review_budget_exceeded is ${found}, not true`
        );
      }
    } else if (taskFeatures.reviewBudgetExceededRecorded === true) {
      features.warnings.push(
        `${taskId}: closeout records review_budget_exceeded: true but derived review rounds (${taskFeatures.derivedReviewRounds}) are within budget (${taskFeatures.reviewBudget})`
      );
    }
  }
}

function finalizeFeatureAggregate(features, triggerCounts) {
  features.minimalismTriggers = sortCountEntries(triggerCounts).map(entry => ({
    trigger: entry.value,
    count: entry.count,
  }));
  features.reviewRounds.tasksOverBudget.sort((a, b) => String(a).localeCompare(String(b)));
  features.reviewRounds.churnTasks.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  features.budgets.nonDefaultAttempt.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  features.budgets.nonDefaultReview.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  features.contextOverflowRisk.tasks.sort((a, b) => String(a).localeCompare(String(b)));
  features.contextPressure.missingForRiskTasks.sort((a, b) => String(a).localeCompare(String(b)));
  features.omissionCandidates.contextRiskPressureNoPredict
    .sort((a, b) => String(a).localeCompare(String(b)));
  features.omissionCandidates.contextRiskOverBudgetNoPredict
    .sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  features.maintainerFixup.tasksWithFixup.sort((a, b) => String(a).localeCompare(String(b)));
  features.maintainerFixup.tasksWithMultipleFixups.sort((a, b) => String(a).localeCompare(String(b)));
  features.warnings.sort((a, b) => a.localeCompare(b));
}

export function reportEventLogs({ target } = {}) {
  const resolvedTarget = target ? resolve(target) : process.cwd();
  const { directory, files } = listEventLogFiles(resolvedTarget);

  const result = {
    directory,
    filesScanned: 0,
    validTaskLogCount: 0,
    invalidLogCount: 0,
    emptyLogCount: 0,
    strictAuditPassCount: 0,
    strictAuditFailCount: 0,
    durableClosureSatisfied: 0,
    durableClosureMissing: 0,
    durableClosureFailing: 0,
    totalCheckOutcomes: { success: 0, failure: 0, blocked: 0 },
    totalReviewOutcomes: { accepted: 0, needs_revision: 0 },
    totalRoleInvokedTargets: [],
    totalDelegationModes: [],
    totalFallbackCount: 0,
    tasksWithReviewChurn: [],
    tasksWithMissingRoleInvoked: [],
    tasksWithMissingTaskStarted: [],
    tasksWithMissingReviewResult: [],
    tasksWithMissingTaskClosed: [],
    provenanceQuality: createEmptyProvenanceQualityAggregate(),
    hostUnknownEvents: [],
    invalidLogs: [],
    emptyLogs: [],
    warnings: [],
    tasks: [],
    features: createEmptyFeatureAggregate(),
    missingLogs: false,
  };

  if (files.length === 0) {
    result.missingLogs = true;
    result.warnings.push(`No event log files found in ${DEFAULT_LOG_DIR_DISPLAY}/`);
    return result;
  }

  const taskEvents = new Map();
  const totalRoleInvokedTargets = new Map();
  const totalDelegationModes = new Map();
  const featureTriggerCounts = new Map();
  let totalFallbackCount = 0;

  for (const filePath of files) {
    result.filesScanned += 1;

    const validation = validateEventLogFile(filePath, { target: resolvedTarget });
    const displayPath = formatEventLogPathForDisplay(filePath, resolvedTarget);
    const hasErrors = validation.errors.length > 0;
    const isEmpty = validation.exists && validation.eventCount === 0;

    if (isEmpty && !hasErrors) {
      result.emptyLogCount += 1;
      result.emptyLogs.push({
        path: filePath,
        displayPath,
        eventCount: validation.eventCount,
        warnings: validation.warnings,
      });
      result.warnings.push(`${displayPath}: event log has zero events`);
      continue;
    }

    if (hasErrors) {
      result.invalidLogCount += 1;
      result.invalidLogs.push({
        path: filePath,
        displayPath,
        eventCount: validation.eventCount,
        errors: validation.errors,
        warnings: validation.warnings,
      });
      continue;
    }

    let parsed;
    try {
      parsed = parseEventLogEntries(filePath);
    } catch (error) {
      result.invalidLogCount += 1;
      result.invalidLogs.push({
        path: filePath,
        displayPath,
        eventCount: validation.eventCount,
        errors: [error.message],
        warnings: validation.warnings,
      });
      continue;
    }

    if (parsed.errors.length > 0) {
      result.invalidLogCount += 1;
      result.invalidLogs.push({
        path: filePath,
        displayPath,
        eventCount: validation.eventCount,
        errors: parsed.errors,
        warnings: validation.warnings,
      });
      continue;
    }

    if (validation.warnings.length > 0) {
      result.warnings.push(...validation.warnings);
    }

    const events = parsed.entries.map(entry => entry.event);
    const fileNameTaskId = filePath.replace(/\\/g, '/').split('/').pop().replace(/\.jsonl$/, '');
    const taskIdsFromEvents = new Set(events.map(event => event.task_id).filter(Boolean));
    const inferredTaskId = taskIdsFromEvents.size === 1
      ? [...taskIdsFromEvents][0]
      : fileNameTaskId;

    const entry = taskEvents.get(inferredTaskId) ?? { files: new Set(), events: [] };
    entry.files.add(displayPath);
    entry.events.push(...events);
    taskEvents.set(inferredTaskId, entry);

    for (const { lineNumber, event } of parsed.entries) {
      if (event.host === 'unknown') {
        result.hostUnknownEvents.push({
          taskId: event.task_id ?? inferredTaskId,
          file: displayPath,
          line: lineNumber,
          eventId: event.event_id,
          inferredTaskId,
          eventTaskId: event.task_id ?? null,
        });
      }
    }
  }

  result.validTaskLogCount = taskEvents.size;

  for (const [taskId, entry] of taskEvents) {
    const summary = summarizeEvents(entry.events, resolvedTarget);

    result.tasks.push({
      taskId,
      files: [...entry.files].sort(),
      ...summary,
    });

    const strictAuditOk = summary.strictAudit.missingEventTypes.length === 0 && summary.strictAudit.durableClosure.satisfied;
    if (strictAuditOk) {
      result.strictAuditPassCount += 1;
    } else {
      result.strictAuditFailCount += 1;
    }

    const hasTaskClosed = entry.events.some(event => event.event_type === 'task.closed');
    if (summary.strictAudit.durableClosure.satisfied) {
      result.durableClosureSatisfied += 1;
    } else if (!hasTaskClosed) {
      result.durableClosureMissing += 1;
    } else {
      result.durableClosureFailing += 1;
    }

    result.totalCheckOutcomes.success += summary.checkRunCounts.success;
    result.totalCheckOutcomes.failure += summary.checkRunCounts.failure;
    result.totalCheckOutcomes.blocked += summary.checkRunCounts.blocked;

    result.totalReviewOutcomes.accepted += summary.reviewResultCounts.accepted;
    result.totalReviewOutcomes.needs_revision += summary.reviewResultCounts.needs_revision;

    for (const targetRoleEntry of summary.roleInvoked.targetRoleCounts) {
      incrementCount(totalRoleInvokedTargets, targetRoleEntry.value, targetRoleEntry.count);
    }
    for (const delegationModeEntry of summary.roleInvoked.delegationModeCounts) {
      incrementCount(totalDelegationModes, delegationModeEntry.value, delegationModeEntry.count);
    }
    totalFallbackCount += summary.roleInvoked.fallbackCount;

    if (summary.reviewResultCounts.needs_revision > 0 || summary.reviewRounds.length > 1) {
      result.tasksWithReviewChurn.push(taskId);
    }

    accumulateTaskFeatures(result.features, featureTriggerCounts, taskId, summarizeTaskFeatures(entry.events));
    accumulateProvenanceQuality(result.provenanceQuality, taskId, summary.provenanceQuality);

    if (!summary.strictAudit.presentEventTypes.includes('role.invoked')) {
      result.tasksWithMissingRoleInvoked.push(taskId);
    }
    if (!summary.strictAudit.presentEventTypes.includes('task.started')) {
      result.tasksWithMissingTaskStarted.push(taskId);
    }
    if (!summary.strictAudit.presentEventTypes.includes('review.result')) {
      result.tasksWithMissingReviewResult.push(taskId);
    }
    if (!summary.strictAudit.presentEventTypes.includes('task.closed')) {
      result.tasksWithMissingTaskClosed.push(taskId);
    }
  }

  result.totalRoleInvokedTargets = sortCountEntries(totalRoleInvokedTargets);
  result.totalDelegationModes = sortCountEntries(totalDelegationModes);
  result.totalFallbackCount = totalFallbackCount;
  finalizeProvenanceQualityAggregate(result.provenanceQuality);
  finalizeFeatureAggregate(result.features, featureTriggerCounts);

  result.tasks.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  result.tasksWithReviewChurn.sort();
  result.tasksWithMissingRoleInvoked.sort();
  result.tasksWithMissingTaskStarted.sort();
  result.tasksWithMissingReviewResult.sort();
  result.tasksWithMissingTaskClosed.sort();
  result.hostUnknownEvents.sort((a, b) => {
    const byTask = String(a.taskId).localeCompare(String(b.taskId));
    if (byTask !== 0) return byTask;
    const byFile = String(a.file).localeCompare(String(b.file));
    if (byFile !== 0) return byFile;
    return a.line - b.line;
  });

  return result;
}
