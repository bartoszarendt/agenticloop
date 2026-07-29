/**
 * Runtime derivation for the terminal-scope decision table.
 *
 * The decision table itself remains in `transition-contract.js`; this module
 * only turns current durable evidence into the two facts that table consumes
 * (`scopeKind`, `auditMode`). It implements every explicit scope evidence type
 * the contract declares:
 *
 *   `typed_human_selection_receipt`        a durable, human-authorized selection
 *                                          document naming an exact task set;
 *   `current_audit_record`                 a validating audit record covering
 *                                          the task;
 *   `current_closeout_marker_or_receipt`   a provenanced closeout marker on the
 *                                          task carrier.
 *
 * Every carrier is checked for authority, identity, freshness, and exact
 * covered-task membership. Conflicting, stale, malformed, or incomplete
 * evidence produces `indeterminate`, which the decision table blocks. `none` is
 * returned only after proving that configured group scope and every explicit
 * durable source are absent, so a scan failure can never be mistaken for the
 * absence of scope.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { markdownSection } from './markdown.js';
import { findAuditRecord, listAuditRecordFiles, parseAuditRecord, validateAuditRecord } from './audit-record.js';
import { PROJECT_MAP_DEFAULTS, resolveWorkUnitAudit } from './project-map.js';
import { resolveTerminalDecision, TRANSITION_TERMINAL_CONTRACT } from './transition-contract.js';
import { CLOSEOUT_MARKER_KEYS, parseCloseoutMarkers, resolveCurrentCloseoutMarkers } from './closeout-contract.js';

/** The explicit scope evidence types the shared contract declares. */
export const EXPLICIT_SCOPE_EVIDENCE_TYPES = TRANSITION_TERMINAL_CONTRACT.explicitScopeEvidenceTypes;

/** Durable carrier for a typed human scope selection. */
export const HUMAN_SCOPE_SELECTION_KIND = 'agenticloop.human-scope-selection';
export const HUMAN_SCOPE_SELECTION_SCHEMA_VERSION = 1;
export const HUMAN_SCOPE_SELECTION_DIRECTORY = '.agenticloop/scope';

const HUMAN_AUTHORITY_PATTERN = /^human:\s*\S(?:.*\S)?$/i;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const KNOWN_TASK_STATUSES = new Set([
  'draft', 'agent-ready', 'in-progress', 'needs_revision', 'blocked', 'needs_context', 'accepted', 'closed',
]);

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a matcher for the configured `task_file_template`.
 *
 * The template may carry prefixes and suffixes and may place `{taskId}` inside
 * a nested directory component. Only paths matching the exact template shape
 * are considered task records, so unrelated Markdown files that happen to sit
 * in the same directory are never scanned.
 *
 * @returns {{pattern: RegExp, rootRelative: string}|null}
 */
export function taskTemplateMatcher(config = PROJECT_MAP_DEFAULTS) {
  const template = String(config?.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template).replace(/\\/g, '/');
  if (!template.includes('{taskId}')) return null;
  if (template.startsWith('/') || /^[a-zA-Z]:/.test(template) || template.split('/').includes('..')) return null;
  const parts = template.split('{taskId}');
  let pattern = escapeRegExp(parts[0]);
  for (let index = 1; index < parts.length; index += 1) {
    // A task id never spans a path separator, so each occurrence matches one
    // segment; later occurrences must equal the first through a backreference.
    pattern += index === 1 ? '([^/]+)' : '\\1';
    pattern += escapeRegExp(parts[index]);
  }
  const staticPrefix = parts[0];
  const rootRelative = staticPrefix.includes('/') ? staticPrefix.slice(0, staticPrefix.lastIndexOf('/')) : '';
  return { pattern: new RegExp(`^${pattern}$`), rootRelative };
}

function walkFiles(root, relativeBase, results, depth = 0) {
  if (depth > 12 || !existsSync(root) || !statSync(root).isDirectory()) return results;
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const stats = statSync(full);
    if (stats.isDirectory()) walkFiles(full, `${relativeBase}${name}/`, results, depth + 1);
    else if (stats.isFile()) results.push({ full, relPath: `${relativeBase}${name}` });
  }
  return results;
}

/**
 * Enumerate current task records through the configured template.
 *
 * Each entry reports whether the record is complete and valid; group membership
 * is only derived from complete valid records, so a malformed carrier makes the
 * scope indeterminate rather than silently shrinking the group.
 */
export function listTaskRecords(target, config = PROJECT_MAP_DEFAULTS) {
  const matcher = taskTemplateMatcher(config);
  if (!matcher) return { ok: false, entries: [], errors: ['task_file_template must contain {taskId} and stay inside the target'] };
  const root = resolve(target, matcher.rootRelative);
  const targetRoot = resolve(target);
  if (root !== targetRoot && !root.startsWith(`${targetRoot}\\`) && !root.startsWith(`${targetRoot}/`)) {
    return { ok: false, entries: [], errors: ['task_file_template resolves outside the target'] };
  }
  const prefix = matcher.rootRelative ? `${matcher.rootRelative}/` : '';
  const entries = [];
  const errors = [];
  for (const file of walkFiles(root, prefix, [])) {
    const match = matcher.pattern.exec(file.relPath);
    if (!match) continue;
    const templateId = match[1];
    const content = readFileSync(file.full, 'utf8');
    const [frontmatter] = parseFrontmatter(content);
    const taskId = String(frontmatter?.task_id ?? '').trim();
    const status = String(frontmatter?.status ?? '').trim();
    const problems = [];
    if (!taskId) problems.push(`task record '${file.relPath}' has no task_id`);
    else if (taskId !== templateId) problems.push(`task record '${file.relPath}' declares task_id '${taskId}' but its path names '${templateId}'`);
    if (!status) problems.push(`task record '${file.relPath}' has no status`);
    else if (!KNOWN_TASK_STATUSES.has(status)) problems.push(`task record '${file.relPath}' has unknown status '${status}'`);
    errors.push(...problems);
    entries.push({
      taskId: taskId || templateId,
      relPath: file.relPath,
      content,
      status,
      grouping: markdownSection(content, '## Grouping')?.body ?? '',
      valid: problems.length === 0,
    });
  }
  return { ok: errors.length === 0, entries, errors };
}

function groupingTokens(grouping) {
  return String(grouping ?? '')
    .split(/[\s,]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function groupingIdentity(token, profile) {
  const match = String(token ?? '').match(/^([a-z]+):([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match || match[1] !== profile) return null;
  return `${match[1]}:${match[2]}`;
}

// ---------------------------------------------------------------------------
// Explicit scope evidence sources
// ---------------------------------------------------------------------------

function indeterminate(reason, evidence = null) {
  return { state: 'indeterminate', reason, evidence };
}

function found({ type, workUnit, tasks, reference, contentDigest }) {
  return {
    state: 'found',
    type,
    workUnit,
    tasks: [...new Set(tasks)].sort(),
    evidence: { type, workUnit, reference, digest: contentDigest, tasks: [...new Set(tasks)].sort() },
  };
}

/** A durable, human-authorized selection with temporal observedAt/max-age freshness. */
function humanSelectionEvidence(target, taskId, now) {
  const directory = resolve(target, HUMAN_SCOPE_SELECTION_DIRECTORY);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return null;
  const matches = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const relPath = `${HUMAN_SCOPE_SELECTION_DIRECTORY}/${name}`;
    const content = readFileSync(join(directory, name), 'utf8');
    let document;
    try {
      document = JSON.parse(content);
    } catch {
      return indeterminate(`human scope selection '${relPath}' is not valid JSON`, { type: 'typed_human_selection_receipt', reference: relPath });
    }
    if (document?.kind !== HUMAN_SCOPE_SELECTION_KIND) continue;
    const problems = [];
    if (document.schemaVersion !== HUMAN_SCOPE_SELECTION_SCHEMA_VERSION) problems.push('unsupported schemaVersion');
    if (typeof document.workUnit !== 'string' || !document.workUnit.trim()) problems.push('missing workUnit');
    if (!Array.isArray(document.tasks) || document.tasks.length === 0 ||
        !document.tasks.every(item => typeof item === 'string' && item.trim())) problems.push('missing or malformed tasks');
    if (typeof document.authority !== 'string' || !HUMAN_AUTHORITY_PATTERN.test(document.authority)) {
      problems.push("authority must be a 'human:<identity>' reference");
    }
    if (typeof document.reason !== 'string' || !document.reason.trim()) problems.push('missing reason');
    if (typeof document.observedAt !== 'string' || !ISO_INSTANT_PATTERN.test(document.observedAt)) problems.push('missing or malformed observedAt');
    const maxAgeSeconds = document.freshnessPolicy?.maxAgeSeconds;
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) problems.push('missing freshnessPolicy.maxAgeSeconds');
    if (problems.length > 0) {
      return indeterminate(
        `human scope selection '${relPath}' is malformed: ${problems.join('; ')}`,
        { type: 'typed_human_selection_receipt', reference: relPath, digest: digest(content) }
      );
    }
    if (!document.tasks.includes(taskId)) continue;
    const ageSeconds = (now - Date.parse(document.observedAt)) / 1000;
    if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
      return indeterminate(
        `human scope selection '${relPath}' is stale or observed in the future; re-record it before a terminal action`,
        { type: 'typed_human_selection_receipt', reference: relPath, digest: digest(content) }
      );
    }
    matches.push(found({
      type: 'typed_human_selection_receipt',
      workUnit: document.workUnit.trim(),
      tasks: document.tasks,
      reference: relPath,
      contentDigest: digest(content),
    }));
  }
  if (matches.length === 0) return null;
  return reduceMatches(matches, 'human scope selections', taskId);
}

/** A current validated audit record bound to its own candidate and covered-task facts, not a time-expiring selection. */
function auditScopeEvidence(target, taskId) {
  const matches = [];
  for (const entry of listAuditRecordFiles(target)) {
    const record = parseAuditRecord(entry.content);
    if (!record.coveredTasks.includes(taskId)) continue;
    const errors = validateAuditRecord(entry.content, entry.relPath);
    if (errors.length > 0) {
      return indeterminate(
        `audit scope evidence '${entry.relPath}' is malformed: ${errors[0]}`,
        { type: 'current_audit_record', reference: entry.relPath, digest: digest(entry.content) }
      );
    }
    matches.push(found({
      type: 'current_audit_record',
      workUnit: record.workUnit,
      tasks: record.coveredTasks,
      reference: entry.relPath,
      contentDigest: digest(entry.content),
    }));
  }
  if (matches.length === 0) return null;
  return reduceMatches(matches, 'audit scope records', taskId);
}

/**
 * A provenanced closeout marker on the task carrier. The marker names its work
 * unit; logical freshness is the supersession-resolved current marker on the
 * current carrier. The exact covered task set always comes from the current
 * validating audit record it references. Configured grouping is resolved
 * authoritatively before explicit-marker evaluation and never acts as a marker
 * fallback.
 */
function closeoutMarkerEvidence(target, taskId, carrierText) {
  if (typeof carrierText !== 'string' || carrierText.length === 0) return null;
  const parsed = parseCloseoutMarkers(carrierText);
  // Only the supersession-resolved current marker set is evidence. A retired
  // marker is history: consuming it would let a superseded scope authorize a
  // terminal action the marker that replaced it no longer covers.
  const resolved = resolveCurrentCloseoutMarkers(parsed);
  if (resolved.error) {
    return indeterminate(resolved.error, { type: 'current_closeout_marker_or_receipt', reference: `task:${taskId}` });
  }
  const markers = resolved.current.filter(marker => marker.provenanced && !marker.malformed);
  const malformed = resolved.current.filter(marker => marker.malformed);
  if (markers.length === 0) {
    if (malformed.length > 0) {
      return indeterminate(
        `the task carrier holds a malformed closeout marker; repair it before a terminal action`,
        { type: 'current_closeout_marker_or_receipt', reference: `task:${taskId}` }
      );
    }
    return null;
  }
  const matches = [];
  for (const marker of markers) {
    const workUnit = String(marker.fields?.[CLOSEOUT_MARKER_KEYS.workUnit] ?? '').trim();
    if (!workUnit) {
      return indeterminate(
        'a closeout marker on the task carrier names no work unit; repair it before a terminal action',
        { type: 'current_closeout_marker_or_receipt', reference: `task:${taskId}` }
      );
    }
    const auditRef = String(marker.fields?.[CLOSEOUT_MARKER_KEYS.audit] ?? 'none').trim();
    let tasks = null;
    if (auditRef && auditRef !== 'none') {
      const entry = findAuditRecord(target, workUnit);
      if (!entry || validateAuditRecord(entry.content, entry.relPath).length > 0) {
        return indeterminate(
          `closeout marker for '${workUnit}' references audit evidence that is missing or invalid`,
          { type: 'current_closeout_marker_or_receipt', reference: `task:${taskId}`, workUnit }
        );
      }
      tasks = parseAuditRecord(entry.content).coveredTasks;
    } else {
      // The marker names a work unit but carries no covered set or audit record.
      // Answering
      // `[taskId]` would invent the scope from the question being asked: every
      // task in the same work unit would derive its own contradictory singleton
      // and each would look like a complete explicit set.
      return indeterminate(
        `closeout marker for '${workUnit}' declares no audit record supplying its covered task set; ` +
          'the exact covered set cannot be derived from the marker alone',
        { type: 'current_closeout_marker_or_receipt', reference: `task:${taskId}`, workUnit }
      );
    }
    if (!tasks.includes(taskId)) {
      return indeterminate(
        `closeout marker for '${workUnit}' does not cover task '${taskId}'`,
        { type: 'current_closeout_marker_or_receipt', reference: `task:${taskId}`, workUnit }
      );
    }
    matches.push(found({
      type: 'current_closeout_marker_or_receipt',
      workUnit,
      tasks,
      reference: `task:${taskId}`,
      contentDigest: digest(carrierText),
    }));
  }
  return reduceMatches(matches, 'closeout markers', taskId);
}

/** Collapse same-source matches, failing closed when they disagree. */
function reduceMatches(matches, label, taskId) {
  const identities = new Set(matches.map(item => `${item.workUnit} ${item.tasks.join(' ')}`));
  if (identities.size !== 1) {
    return indeterminate(`multiple conflicting current ${label} cover task '${taskId}'`, {
      type: matches[0].type,
      records: matches.map(item => item.evidence),
    });
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

function scopeResult(scopeKind, auditMode, extra = {}) {
  return {
    scopeKind,
    auditMode,
    workUnit: extra.workUnit ?? null,
    tasks: extra.tasks ?? [],
    evidence: extra.evidence ?? null,
    reasons: extra.reasons ?? [],
    decision: resolveTerminalDecision({ scopeKind, auditMode }),
  };
}

/**
 * Resolve the terminal scope for one task from durable local evidence.
 *
 * `taskBody` supports GitHub projections: a lone issue body cannot prove a
 * complete inventory, so configured group closeout stays indeterminate unless
 * the caller supplies one.
 */
export function resolveCanonicalTerminalScope({
  target,
  config = PROJECT_MAP_DEFAULTS,
  taskId,
  taskBody = null,
  closeoutMarkerText = null,
  inventoryComplete = true,
  now = Date.now(),
} = {}) {
  const auditMode = resolveWorkUnitAudit(config) === 'disabled' ? 'disabled' : 'enabled';
  const id = String(taskId ?? '').trim();
  if (!id) {
    return scopeResult('indeterminate', auditMode, {
      reasons: ['task identity is required to derive terminal closeout scope'],
    });
  }

  const groupCloseout = config?.group_closeout === true;
  const profile = String(config?.grouping_profile ?? 'flat');
  const inventory = taskBody === null ? listTaskRecords(target, config) : null;
  if (groupCloseout) {
    if (profile === 'flat') {
      return scopeResult('indeterminate', auditMode, {
        reasons: ['group_closeout is enabled but grouping_profile is flat; repair project scope configuration and re-derive'],
      });
    }
    if (!inventoryComplete || inventory === null) {
      return scopeResult('indeterminate', auditMode, {
        reasons: ['configured group closeout requires a complete current task inventory; repair and re-derive scope'],
      });
    }
    if (!inventory.ok) {
      return scopeResult('indeterminate', auditMode, {
        reasons: [`configured group closeout requires complete valid task records: ${inventory.errors[0]}`],
      });
    }
    const current = inventory.entries.filter(entry => entry.taskId === id);
    if (current.length !== 1) {
      return scopeResult('indeterminate', auditMode, {
        reasons: [`configured group closeout cannot identify exactly one current carrier for task '${id}'`],
      });
    }
    const identities = groupingTokens(current[0].grouping)
      .map(token => groupingIdentity(token, profile))
      .filter(Boolean);
    if (identities.length !== 1) {
      return scopeResult('indeterminate', auditMode, {
        reasons: [`configured group closeout requires exactly one '${profile}:<id>' grouping token for task '${id}'`],
      });
    }
    const workUnit = identities[0];
    const members = inventory.entries
      .filter(entry => groupingTokens(entry.grouping).includes(workUnit))
      .map(entry => entry.taskId)
      .sort();
    if (members.length === 0) {
      return scopeResult('indeterminate', auditMode, {
        reasons: [`configured group '${workUnit}' has no current members; repair and re-derive scope`],
      });
    }
    return scopeResult('configured_group', auditMode, {
      workUnit,
      tasks: members,
      evidence: {
        type: 'configured_group_membership',
        workUnit,
        tasks: members,
        digest: digest(inventory.entries.map(entry => `${entry.relPath}\n${entry.content}`).join('\n \n')),
      },
    });
  }

  // Explicit durable scope evidence. Every accepted source is consulted before
  // `none` can be returned.
  const carrierText = closeoutMarkerText !== null
    ? closeoutMarkerText
    : taskBody !== null
      ? taskBody
    : inventory?.entries.find(entry => entry.taskId === id)?.content ?? null;
  const sources = [
    humanSelectionEvidence(target, id, now),
    auditScopeEvidence(target, id),
    closeoutMarkerEvidence(target, id, carrierText),
  ].filter(Boolean);

  const blocked = sources.find(source => source.state === 'indeterminate');
  if (blocked) {
    return scopeResult('indeterminate', auditMode, { reasons: [blocked.reason], evidence: blocked.evidence });
  }
  if (sources.length > 0) {
    const identities = new Set(sources.map(source => `${source.workUnit} ${source.tasks.join(' ')}`));
    if (identities.size !== 1) {
      return scopeResult('indeterminate', auditMode, {
        reasons: [`explicit scope evidence for task '${id}' is contradictory across ${sources.map(source => source.type).join(', ')}`],
        evidence: { type: 'explicit_scope_conflict', records: sources.map(source => source.evidence) },
      });
    }
    const [primary] = sources;
    return scopeResult('explicit_task_set', auditMode, {
      workUnit: primary.workUnit,
      tasks: primary.tasks,
      evidence: sources.length === 1
        ? primary.evidence
        : { type: 'corroborated_explicit_scope', workUnit: primary.workUnit, tasks: primary.tasks, records: sources.map(source => source.evidence) },
    });
  }

  // A scan that could not read the inventory is missing evidence, not proof
  // that no scope exists.
  if (taskBody === null && inventory && !inventory.ok) {
    return scopeResult('indeterminate', auditMode, {
      reasons: [`current task records could not be validated, so the absence of scope cannot be proven: ${inventory.errors[0]}`],
    });
  }
  return scopeResult('none', auditMode, { tasks: [id], evidence: { type: 'no_scope', taskId: id } });
}

/**
 * Derive all current configured group scopes for audit-due reporting.
 *
 * Inventory failure is returned explicitly. An empty scope list is reserved for
 * a successful derivation that found no configured scopes.
 */
export function deriveConfiguredGroupScopes(target, config = PROJECT_MAP_DEFAULTS) {
  if (config?.group_closeout !== true || String(config?.grouping_profile ?? 'flat') === 'flat') {
    return { ok: true, scopes: [], errors: [] };
  }
  const inventory = listTaskRecords(target, config);
  if (!inventory.ok) return { ok: false, scopes: [], errors: inventory.errors };
  const groups = new Map();
  for (const entry of inventory.entries) {
    if (entry.status !== 'accepted' && entry.status !== 'closed') continue;
    const scope = resolveCanonicalTerminalScope({ target, config, taskId: entry.taskId });
    if (scope.scopeKind !== 'configured_group' || !scope.workUnit) continue;
    groups.set(scope.workUnit, scope.tasks);
  }
  return {
    ok: true,
    scopes: [...groups.entries()]
      .map(([workUnit, tasks]) => ({ workUnit, tasks: [...new Set(tasks)].sort() }))
      .sort((left, right) => (left.workUnit < right.workUnit ? -1 : left.workUnit > right.workUnit ? 1 : 0)),
    errors: [],
  };
}

/**
 * Derive explicit-task-set scopes for audit-due reporting, using the same
 * resolver and evidence as terminal enforcement so the two can never disagree.
 */
export function deriveExplicitScopes(target, config = PROJECT_MAP_DEFAULTS) {
  const inventory = listTaskRecords(target, config);
  if (!inventory.ok) return { ok: false, scopes: [], errors: inventory.errors };
  const groups = new Map();
  for (const entry of inventory.entries) {
    if (entry.status !== 'accepted' && entry.status !== 'closed') continue;
    const scope = resolveCanonicalTerminalScope({ target, config, taskId: entry.taskId });
    if (scope.scopeKind !== 'explicit_task_set' || !scope.workUnit) continue;
    groups.set(scope.workUnit, scope.tasks);
  }
  return {
    ok: true,
    scopes: [...groups.entries()]
      .map(([workUnit, tasks]) => ({ workUnit, tasks: [...new Set(tasks)].sort() }))
      .sort((left, right) => (left.workUnit < right.workUnit ? -1 : left.workUnit > right.workUnit ? 1 : 0)),
    errors: [],
  };
}

/** Return a current audit record only when its exact durable record validates. */
export function currentAuditScopeRecord(target, workUnit) {
  const entry = findAuditRecord(target, workUnit);
  if (!entry || validateAuditRecord(entry.content, entry.relPath).length > 0) return null;
  return entry;
}

/** Relative path of one files-backed task record under the configured template. */
export function taskRecordRelativePath(config, taskId) {
  return String(config?.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template)
    .replace(/\\/g, '/')
    .replaceAll('{taskId}', String(taskId));
}
