/**
 * Shared typed durable-reference resolver.
 *
 * "Lesson recorded" claims and improvement `source_refs` must name real,
 * live artifacts. This module resolves every supported reference form against
 * live backend state and rejects unknown or ambiguous syntax:
 *
 * - `AUD-001` and `AUD-001/run:2`            audit records and runs
 * - `T-012` (project task id pattern)        files or GitHub task carriers
 * - `#12`                                    legacy GitHub issue identity
 * - `D-YYYY-MM-DD-NNN`                       decision records
 * - `I-YYYY-MM-DD-NNN`                       improvement proposals
 * - `sha256:<64 hex>`                        closeout marker gate digests
 *
 * Anything else is an explicit error; references are retained exactly and
 * never silently rewritten.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAuditRecordFiles, parseAuditRecord } from './audit-record.js';
import { parseCloseoutMarkers } from './closeout-contract.js';
import { fetchGitHubTaskInventory, resolveGhRunner } from './closeout-github.js';
import { resolveCoveredGitHubTask } from './github-task-identity.js';
import { IMPROVEMENT_ID_PATTERN, IMPROVEMENTS_DIRECTORY_RELATIVE_PATH, listImprovementProposals } from './improvement.js';
import { markdownSection } from './markdown.js';
import { createLocalVerificationContext } from './verification-context.js';

const AUDIT_REF_PATTERN = /^AUD-\d{3,}(?:\/run:\d+)?$/;
const DECISION_REF_PATTERN = /^D-\d{4}-\d{2}-\d{2}-\d{3,}$/;
const MARKER_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISSUE_REF_PATTERN = /^#\d+$/;

function taskIdMatcher(taskIdRegex) {
  if (taskIdRegex instanceof RegExp) return value => taskIdRegex.test(value);
  if (typeof taskIdRegex === 'string' && taskIdRegex.trim()) {
    const pattern = new RegExp(taskIdRegex.trim());
    return value => pattern.test(value);
  }
  return value => /^T-\d{3,}$/.test(value);
}

/**
 * Build the live reference context for one command. Callers supply the
 * configured backend facts; the context is built once per command and reused
 * by every reference check.
 *
 * @param {string} target
 * @param {object} [options]
 * @param {string} [options.taskIdRegex]
 * @param {(taskId: string) => boolean} [options.taskExists]  Backend task existence.
 * @param {(taskId: string) => { found: boolean, error?: string|null }} [options.resolveTask]
 *   Richer backend lookup (GitHub inventory); wins over taskExists.
 * @param {string[]} [options.taskRecordContents]  Files-backend task records used
 *   to collect closeout marker digests.
 * @param {string[]} [options.markerContents]  Already-extracted marker carrier
 *   text, such as trusted GitHub issue comments.
 * @returns {object}
 */
export function buildDurableReferenceContext(target, options = {}) {
  const audits = new Map();
  for (const entry of listAuditRecordFiles(target)) {
    const record = parseAuditRecord(entry.content);
    if (record.auditId) {
      audits.set(record.auditId, {
        auditId: record.auditId,
        runs: record.history?.length ?? 0,
        workUnit: record.workUnit ?? '',
      });
    }
  }
  const improvements = new Map();
  for (const entry of listImprovementProposals(target)) {
    improvements.set(entry.improvementId, entry);
  }
  const markerDigests = new Set();
  for (const content of options.taskRecordContents ?? []) {
    const comments = markdownSection(content, '## Comments')?.body ?? '';
    for (const marker of parseCloseoutMarkers(comments)) {
      const digest = String(marker.fields?.AGENT_CLOSEOUT_GATE ?? '');
      if (MARKER_REF_PATTERN.test(digest)) markerDigests.add(digest);
    }
  }
  for (const content of options.markerContents ?? []) {
    for (const marker of parseCloseoutMarkers(content)) {
      const digest = String(marker.fields?.AGENT_CLOSEOUT_GATE ?? '');
      if (MARKER_REF_PATTERN.test(digest)) markerDigests.add(digest);
    }
  }
  return {
    target,
    taskIdRegex: options.taskIdRegex,
    matchesTaskId: taskIdMatcher(options.taskIdRegex),
    taskExists: options.taskExists ?? null,
    resolveTask: options.resolveTask ?? null,
    audits,
    improvements,
    markerDigests,
  };
}

/**
 * Resolve one durable reference against live backend state.
 *
 * @param {object} context  buildDurableReferenceContext result.
 * @param {string} ref
 * @returns {{ ok: boolean, kind?: string, error?: string }}
 */
export function resolveDurableReference(context, ref) {
  const value = String(ref ?? '').trim();
  if (!value) {
    return { ok: false, error: 'empty reference' };
  }

  if (AUDIT_REF_PATTERN.test(value)) {
    const [auditId, runPart] = value.split('/run:');
    const audit = context.audits.get(auditId);
    if (!audit) {
      return { ok: false, error: `audit record '${auditId}' does not exist` };
    }
    if (runPart !== undefined) {
      const run = Number(runPart);
      if (!Number.isSafeInteger(run) || run < 1 || run > audit.runs) {
        return { ok: false, error: `audit record '${auditId}' has no run ${runPart} (${audit.runs} recorded)` };
      }
    }
    return { ok: true, kind: 'audit' };
  }

  if (IMPROVEMENT_ID_PATTERN.test(value)) {
    return context.improvements.has(value)
      ? { ok: true, kind: 'improvement' }
      : { ok: false, error: `improvement proposal '${value}' does not exist` };
  }

  if (DECISION_REF_PATTERN.test(value)) {
    const file = join(context.target, '.agenticloop', 'decisions', `${value}.md`);
    return existsSync(file)
      ? { ok: true, kind: 'decision' }
      : { ok: false, error: `decision record '${value}' does not exist` };
  }

  if (MARKER_REF_PATTERN.test(value)) {
    return context.markerDigests.has(value)
      ? { ok: true, kind: 'closeout_marker' }
      : { ok: false, error: `no recorded closeout marker carries gate digest '${value}'` };
  }

  if (ISSUE_REF_PATTERN.test(value)) {
    if (typeof context.resolveTask === 'function') {
      const resolved = context.resolveTask(value);
      return resolved.found
        ? { ok: true, kind: 'task' }
        : { ok: false, error: resolved.error ?? `issue '${value}' does not exist` };
    }
    return { ok: false, error: `issue-number reference '${value}' requires the github task backend` };
  }

  if (context.matchesTaskId(value)) {
    if (typeof context.resolveTask === 'function') {
      const resolved = context.resolveTask(value);
      if (!resolved.found) {
        return { ok: false, error: resolved.error ?? `task '${value}' does not exist` };
      }
      return { ok: true, kind: 'task' };
    }
    if (typeof context.taskExists === 'function') {
      return context.taskExists(value)
        ? { ok: true, kind: 'task' }
        : { ok: false, error: `task '${value}' does not exist` };
    }
    return { ok: false, error: `task reference '${value}' cannot be resolved without backend state` };
  }

  return {
    ok: false,
    error:
      `unrecognized durable reference '${value}'; supported forms are ` +
      'AUD-<id>[/run:<n>], a project task id, #<issue> (github backend), ' +
      'D-YYYY-MM-DD-NNN, I-YYYY-MM-DD-NNN, or sha256:<closeout-marker-digest>',
  };
}

/**
 * Resolve every reference; returns one error per unresolvable reference.
 *
 * @param {object} context
 * @param {string[]} refs
 * @param {string} noun  Display noun for error messages (e.g. 'source_ref').
 * @returns {string[]}
 */
export function durableReferenceErrors(context, refs, noun = 'reference') {
  const errors = [];
  for (const ref of refs ?? []) {
    const resolved = resolveDurableReference(context, ref);
    if (!resolved.ok) {
      errors.push(`${noun} '${String(ref ?? '').trim()}' is not resolvable: ${resolved.error}`);
    }
  }
  return errors;
}

/**
 * Build the live reference context for one CLI command, resolving backend
 * state through the injected or default GitHub runner. GitHub inventory is
 * fetched at most once per command.
 *
 * @param {string} target
 * @param {object} config  Merged project-map config.
 * @param {object} [io]
 * @param {{ inventory?: object, repo?: string, markerContents?: string[] }} [options]
 * @returns {object}
 */
export function buildCliDurableReferenceContext(target, config, io = null, options = {}) {
  if (String(config?.task_backend ?? 'files') === 'github') {
    const inventory = options.inventory ?? fetchGitHubTaskInventory(resolveGhRunner(io), {
      repo: options.repo,
      taskIdRegex: config?.task_id_regex,
    });
    return buildDurableReferenceContext(target, {
      taskIdRegex: config?.task_id_regex,
      resolveTask: taskId => resolveCoveredGitHubTask(inventory, taskId),
      markerContents: options.markerContents ?? [],
    });
  }
  const context = createLocalVerificationContext(target);
  return buildDurableReferenceContext(target, {
    taskIdRegex: config?.task_id_regex,
    taskExists: context.taskExists,
    taskRecordContents: readTaskRecordContents(target, config),
  });
}

/**
 * Read every files-backend task record for marker-digest collection.
 *
 * @param {string} target
 * @param {object} config
 * @returns {string[]}
 */
export function readTaskRecordContents(target, config) {
  const template = String(config?.task_file_template ?? '.agenticloop/tasks/{taskId}.md').replace(/\\/g, '/');
  const tasksDir = template.includes('{taskId}') ? template.split('{taskId}')[0] : '.agenticloop/tasks/';
  const dir = join(target, tasksDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => readFileSync(join(dir, name), 'utf-8'));
}
