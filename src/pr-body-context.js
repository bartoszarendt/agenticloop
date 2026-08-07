/**
 * Versioned PR-body evaluation-context snapshot envelope.
 *
 * `pr-body scaffold --snapshot-output` serializes the complete preparation
 * context it already loaded (plus materialized task/decision reference
 * inventories) inside this envelope. `pr-body lint --snapshot` reloads it with
 * zero network access. The envelope carries provenance (capture time,
 * repository, PR, issue, head, base, fixed review mode) next to the nested
 * input; both identity layers must agree. The candidate
 * Markdown body is never part of the snapshot: `--body-file` always replaces
 * the nested remote `prData.body` in memory before normalization/evaluation.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadProjectMap, PROJECT_MAP_DEFAULTS } from './project-map.js';
import { createDiagnostic } from './repair-policy.js';
import { isGitObjectId, sameGitObjectFormat } from './git-oid.js';

export const PR_BODY_SNAPSHOT_KIND = 'agenticloop.pr-body-context';
export const PR_BODY_SNAPSHOT_SCHEMA_VERSION = 1;

const INVENTORY_LIMIT = 1000;
const INVENTORY_SCAN_LIMIT = 10000;
const ISO_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidUtcTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC_TIMESTAMP_RE.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  const date = new Date(parsed);
  return Boolean(parts) &&
    date.getUTCFullYear() === Number(parts[1]) &&
    date.getUTCMonth() + 1 === Number(parts[2]) &&
    date.getUTCDate() === Number(parts[3]) &&
    date.getUTCHours() === Number(parts[4]) &&
    date.getUTCMinutes() === Number(parts[5]) &&
    date.getUTCSeconds() === Number(parts[6]);
}

function diagnostic(message) {
  return createDiagnostic({ code: 'pr_body.snapshot', message });
}

function insideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function taskTemplateMatcher(template) {
  const parts = template.split('{taskId}');
  const pattern = parts.map(escapeRegex).join('([^/]+)');
  return { regex: new RegExp(`^${pattern}$`), captureCount: parts.length - 1 };
}

function collectFiles(root, limit = INVENTORY_SCAN_LIMIT) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(full);
      if (files.length + pending.length > limit) {
        throw new Error(`task reference inventory scan exceeds the ${limit}-entry safety bound`);
      }
    }
  }
  return files;
}

/**
 * Materialize bounded local task/decision reference inventories so an offline
 * snapshot can resolve the same references the live resolver functions cover.
 * Inventories are sorted and capture fails explicitly when a target exceeds
 * the record or scan safety bounds.
 */
export function materializeReferenceInventories(target, options = {}) {
  const root = resolve(target);
  const decisionIds = [];
  const decisionsDir = join(root, '.agenticloop', 'decisions');
  if (existsSync(decisionsDir)) {
    for (const entry of readdirSync(decisionsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) decisionIds.push(entry.name.slice(0, -3));
    }
  }
  if (decisionIds.length > INVENTORY_LIMIT) {
    throw new Error(`decision reference inventory exceeds the ${INVENTORY_LIMIT}-record snapshot bound`);
  }
  const projectMap = options.projectMap === undefined ? loadProjectMap(root) : options.projectMap;
  const projectConfig = projectMap?.config ?? PROJECT_MAP_DEFAULTS;
  const template = String(projectConfig?.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template).replace(/\\/g, '/');
  const taskIds = new Set();
  if (template.includes('{taskId}')) {
    const staticPrefix = template.slice(0, template.indexOf('{taskId}'));
    const prefixDirectory = staticPrefix.endsWith('/') ? staticPrefix : dirname(staticPrefix || '.');
    const scanRoot = resolve(root, prefixDirectory || '.');
    if (!insideRoot(root, scanRoot)) {
      throw new Error('task_file_template resolves outside the target project');
    }
    if (existsSync(scanRoot)) {
      const matcher = taskTemplateMatcher(template);
      for (const file of collectFiles(scanRoot)) {
        const rel = relative(root, file).replace(/\\/g, '/');
        const match = rel.match(matcher.regex);
        if (!match) continue;
        const captures = match.slice(1, matcher.captureCount + 1);
        if (captures.length > 0 && captures.every(id => id === captures[0])) {
          taskIds.add(captures[0]);
          if (taskIds.size > INVENTORY_LIMIT) {
            throw new Error(`task reference inventory exceeds the ${INVENTORY_LIMIT}-record snapshot bound`);
          }
        }
      }
    }
  }
  return {
    decisionIds: decisionIds.sort(),
    taskIds: [...taskIds].sort(),
  };
}

/**
 * Build the versioned snapshot envelope around a complete preparation input.
 * The caller is responsible for materializing reference inventories into
 * `input.references` before capture; this function only adds provenance.
 */
export function createPrBodySnapshot({ input, repository = null, capturedAt } = {}) {
  if (!isObject(input)) {
    throw new Error('createPrBodySnapshot requires a complete preparation input object');
  }
  if (typeof repository !== 'string' || !REPOSITORY_RE.test(repository.trim())) {
    throw new Error("createPrBodySnapshot requires repository identity in 'owner/name' form");
  }
  if (capturedAt !== undefined && !isValidUtcTimestamp(capturedAt)) {
    throw new Error('createPrBodySnapshot capturedAt must be a valid UTC ISO timestamp');
  }
  if (input.mode !== 'review') {
    throw new Error("createPrBodySnapshot input mode must be 'review'");
  }
  const head = input.prData?.headRefOid;
  const base = input.prData?.baseRefOid;
  if (!isGitObjectId(head) || !isGitObjectId(base) || !sameGitObjectFormat([head, base])) {
    throw new Error('createPrBodySnapshot requires lowercase full base/head Git object identities in one object format');
  }
  return {
    kind: PR_BODY_SNAPSHOT_KIND,
    snapshotSchemaVersion: PR_BODY_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: capturedAt ?? new Date().toISOString(),
    repository: repository.trim(),
    pr: input.prData?.number ?? null,
    issue: input.issueData?.number ?? null,
    head,
    base,
    mode: 'review',
    input,
  };
}

/**
 * Validate a parsed snapshot envelope: kind, version, provenance fields, and
 * internal identity agreement between the envelope and the nested preparation
 * input. `expected` may declare explicitly expected identities
 * (`{ pr, issue, repo }`); a mismatch against any of them fails closed. The
 * current working directory is never treated as snapshot identity.
 *
 * @returns {{ ok: boolean, errors: Array<object>, value: null|{ input: object, provenance: object } }}
 */
export function normalizePrBodySnapshot(raw, options = {}) {
  const errors = [];
  if (!isObject(raw)) {
    return { ok: false, errors: [diagnostic('snapshot must be a JSON object')], value: null };
  }
  if (raw.kind !== PR_BODY_SNAPSHOT_KIND) {
    errors.push(diagnostic(`snapshot kind must be '${PR_BODY_SNAPSHOT_KIND}', got '${raw.kind ?? 'missing'}'`));
  }
  if (raw.snapshotSchemaVersion !== PR_BODY_SNAPSHOT_SCHEMA_VERSION) {
    errors.push(diagnostic(`snapshot snapshotSchemaVersion must be ${PR_BODY_SNAPSHOT_SCHEMA_VERSION}, got '${raw.snapshotSchemaVersion ?? 'missing'}'`));
  }
  if (!isValidUtcTimestamp(raw.capturedAt)) {
    errors.push(diagnostic('snapshot capturedAt must be a valid UTC ISO timestamp'));
  }
  if (typeof raw.repository !== 'string' || !REPOSITORY_RE.test(raw.repository.trim())) {
    errors.push(diagnostic("snapshot repository must use nonempty 'owner/name' identity"));
  }
  if (!Number.isInteger(raw.pr) || raw.pr <= 0) {
    errors.push(diagnostic('snapshot pr must be a positive integer'));
  }
  if (!Number.isInteger(raw.issue) || raw.issue <= 0) {
    errors.push(diagnostic('snapshot issue must be a positive integer'));
  }
  if (!isGitObjectId(raw.head)) {
    errors.push(diagnostic('snapshot head must be a full Git object identity (40- or 64-character lowercase hex)'));
  }
  if (!isGitObjectId(raw.base)) {
    errors.push(diagnostic('snapshot base must be a full Git object identity (40- or 64-character lowercase hex)'));
  }
  if (isGitObjectId(raw.head) && isGitObjectId(raw.base) && !sameGitObjectFormat([raw.head, raw.base])) {
    errors.push(diagnostic('snapshot head and base must use one Git object format'));
  }
  if (raw.mode !== 'review') {
    errors.push(diagnostic("snapshot mode must be 'review'; PR-body lint never evaluates authoring-mode snapshots"));
  }
  if (!isObject(raw.input)) {
    errors.push(diagnostic('snapshot is missing the nested complete preparation input object'));
  }

  if (isObject(raw.input)) {
    const input = raw.input;
    if (input.mode !== 'review') {
      errors.push(diagnostic("snapshot nested input mode must be 'review'"));
    }
    if (Number.isInteger(raw.pr) && input.prData?.number !== raw.pr) {
      errors.push(diagnostic(`snapshot pr #${raw.pr} disagrees with nested input prData.number ${input.prData?.number ?? 'missing'}`));
    }
    if (Number.isInteger(raw.issue) && input.issueData?.number !== raw.issue) {
      errors.push(diagnostic(`snapshot issue #${raw.issue} disagrees with nested input issueData.number ${input.issueData?.number ?? 'missing'}`));
    }
    const nestedHead = input.prData?.headRefOid;
    const nestedBase = input.prData?.baseRefOid;
    if (!isGitObjectId(nestedHead)) {
      errors.push(diagnostic('snapshot nested input prData.headRefOid must be a full lowercase Git object identity'));
    } else if (isGitObjectId(raw.head) && nestedHead !== raw.head) {
      errors.push(diagnostic('snapshot head disagrees with nested input prData.headRefOid'));
    }
    if (!isGitObjectId(nestedBase)) {
      errors.push(diagnostic('snapshot nested input prData.baseRefOid must be a full lowercase Git object identity'));
    } else if (isGitObjectId(raw.base) && nestedBase !== raw.base) {
      errors.push(diagnostic('snapshot base disagrees with nested input prData.baseRefOid'));
    }
    if (isGitObjectId(nestedHead) && isGitObjectId(nestedBase) && !sameGitObjectFormat([nestedHead, nestedBase])) {
      errors.push(diagnostic('snapshot nested input base/head identities must use one Git object format'));
    }
  }

  const expected = options.expected ?? {};
  if (expected.pr !== undefined && expected.pr !== null && Number(expected.pr) !== raw.pr) {
    errors.push(diagnostic(`snapshot was captured for PR #${raw.pr}, not expected PR #${expected.pr}`));
  }
  if (expected.issue !== undefined && expected.issue !== null && Number(expected.issue) !== raw.issue) {
    errors.push(diagnostic(`snapshot was captured for issue #${raw.issue}, not expected issue #${expected.issue}`));
  }
  if (expected.repo && raw.repository && String(expected.repo).toLowerCase() !== String(raw.repository).toLowerCase()) {
    errors.push(diagnostic(`snapshot was captured for repository '${raw.repository}', not expected repository '${expected.repo}'`));
  }

  if (errors.length > 0) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: {
      input: raw.input,
      provenance: {
        repository: raw.repository.trim(),
        pr: raw.pr,
        issue: raw.issue,
        head: raw.head,
        base: raw.base,
        mode: 'review',
        capturedAt: raw.capturedAt,
      },
    },
  };
}
