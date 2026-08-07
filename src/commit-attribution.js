/** Read-only validation and canonical repair guidance for commit attribution. */

import { markdownLines } from './markdown.js';
import { createDiagnostic } from './repair-policy.js';
import { WORKFLOW_ROLE_SET } from './workflow-vocabulary.js';
import { isGitObjectId } from './git-oid.js';

const TRAILER_LINE_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\s*:\s*(.+?)\s*$/;
const NAMED_TRAILER_RE = /^(Task|Agent)\s*:\s*(.+?)\s*$/i;

export const ATTRIBUTION_REPAIR_RECORD_KIND = 'agenticloop.attribution-repair';

/** Validate the durable record required after an exceptional metadata rewrite. */
export function validateAttributionRepairRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, errors: ['attribution repair record must be an object'] };
  if (record.kind !== ATTRIBUTION_REPAIR_RECORD_KIND) errors.push(`attribution repair record requires kind '${ATTRIBUTION_REPAIR_RECORD_KIND}'`);
  for (const field of ['originalSha', 'resultingSha']) {
    if (!isGitObjectId(record[field])) errors.push(`attribution repair record requires ${field} as a full Git object identity (40- or 64-character lowercase hex)`);
  }
  if (record.originalSha && record.resultingSha && String(record.originalSha).toLowerCase() === String(record.resultingSha).toLowerCase()) {
    errors.push('attribution repair record originalSha and resultingSha must differ');
  }
  for (const field of ['branchRef', 'contentOwnerRole', 'repairOperator', 'reason', 'authority', 'timestamp']) {
    if (!String(record[field] ?? '').trim()) errors.push(`attribution repair record requires ${field}`);
  }
  if (record.contentOwnerRole && !WORKFLOW_ROLE_SET.has(record.contentOwnerRole)) {
    errors.push('attribution repair record contentOwnerRole must be a workflow role');
  }
  if (record.branchRef && !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(record.branchRef)) {
    errors.push('attribution repair record branchRef must be a refs/heads/<branch> reference');
  }
  if (record.authority && !/^[a-z][a-z0-9_-]*:\s*\S/i.test(record.authority)) {
    errors.push('attribution repair record authority must be a durable <kind>:<reference>');
  }
  if (record.timestamp && Number.isNaN(Date.parse(record.timestamp))) errors.push('attribution repair record timestamp must be ISO-compatible');
  for (const field of ['invalidatedEvidence', 'rerunEvidence']) {
    if (!Array.isArray(record[field]) || record[field].length === 0 || record[field].some(value => !String(value ?? '').trim())) errors.push(`attribution repair record requires non-empty ${field} array`);
  }
  return { ok: errors.length === 0, errors };
}

/** Render one canonical read-only candidate for the durable backend carrier. */
export function renderAttributionRepairRecord(record) {
  const validation = validateAttributionRepairRecord(record);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function lintAttributionRepairRecord(text) {
  try {
    const record = JSON.parse(String(text ?? ''));
    const validation = validateAttributionRepairRecord(record);
    return { ...validation, record };
  } catch {
    return { ok: false, errors: ['attribution repair record must be valid JSON'], record: null };
  }
}

/**
 * The one canonical final-trailer-block parser, shared by the local
 * commit-attribution check and the live preflight attribution validation.
 *
 * The block is the final contiguous run of `Token: value` trailer lines at the
 * end of the message (Git trailer token rule: alphanumerics and dashes). A
 * blank separator before the block is not required; standard Git trailers such
 * as Co-authored-by or Signed-off-by may be mixed into the block. Arbitrary
 * message prose is never scanned as trailers: scanning is bottom-up over live
 * lines only (fenced code, blockquotes, and indented code are ignored), and
 * Task/Agent lines outside the block are reported as misplaced rather than
 * treated as authoritative trailers.
 */
export function parseFinalTrailerBlock(message) {
  const live = markdownLines(String(message ?? ''))
    .filter(line => line.live)
    .map(line => line.raw);
  let end = live.length - 1;
  while (end >= 0 && !live[end].trim()) end--;
  const trailers = [];
  let start = end;
  for (; start >= 0; start--) {
    const line = live[start].trim();
    if (!line || !TRAILER_LINE_RE.test(line)) break;
    trailers.unshift(line);
  }
  const misplaced = [];
  for (const line of live.slice(0, start + 1)) {
    const trimmed = line.trim();
    if (NAMED_TRAILER_RE.test(trimmed)) misplaced.push(trimmed);
  }
  return {
    block: trailers.length ? trailers.join('\n') : null,
    trailers,
    named: namedTrailersIn(trailers),
    misplaced,
  };
}

function namedTrailersIn(lines) {
  const found = [];
  for (const line of lines) {
    const match = line.match(NAMED_TRAILER_RE);
    if (match) found.push({ name: match[1].toLowerCase(), value: match[2].trim(), line });
  }
  return found;
}

/**
 * Validate commit attribution over the final contiguous trailer block only.
 * The command is strictly read-only: it returns a canonical replace/remove
 * repair plan and never amends, rewrites, commits, or pushes anything.
 */
export function evaluateCommitAttribution({ message, taskId, role = 'engineer' } = {}) {
  const errors = [];
  const task = String(taskId ?? '').trim();
  const expectedRole = String(role ?? '').trim().toLowerCase();
  if (!task) errors.push('task id is required for commit attribution');

  const { block, named, misplaced } = parseFinalTrailerBlock(message);
  const tasks = named.filter(entry => entry.name === 'task').map(entry => entry.value);
  const agents = named.filter(entry => entry.name === 'agent').map(entry => entry.value.toLowerCase());

  // Task/Agent tokens that appear outside the final trailer block (in prose or
  // an earlier paragraph) are not authoritative trailers and must not be
  // scanned as if they were valid.
  if (misplaced.length) {
    errors.push(`misplaced Task/Agent trailer(s) appear outside the final contiguous trailer block: ${[...new Set(misplaced)].join(', ')}`);
  }

  if (!block) {
    errors.push(`missing final contiguous trailer block; expected a final 'Task: ${task}' and 'Agent: ${expectedRole}' paragraph`);
  } else {
    if (tasks.length === 0) errors.push(`missing Task trailer; expected 'Task: ${task}'`);
    if (agents.length === 0) errors.push(`missing Agent trailer; expected 'Agent: ${expectedRole}'`);
    if (tasks.length > 1) errors.push('duplicate Task trailers must be removed');
    if (agents.length > 1) errors.push('duplicate Agent trailers must be removed');
    if (tasks.length === 1 && task && tasks[0] !== task) errors.push(`stale Task trailer '${tasks[0]}'; expected '${task}'`);
    if (agents.length === 1 && expectedRole && agents[0] !== expectedRole) errors.push(`wrong Agent trailer '${agents[0]}'; expected '${expectedRole}'`);
  }

  const repair = [`Task: ${task}`, `Agent: ${expectedRole}`].join('\n');
  return {
    schemaVersion: 1,
    ok: errors.length === 0,
    errors,
    warnings: [],
    diagnostics: errors.map(message => createDiagnostic({ code: 'attribution.trailer', message })),
    repairPlan: errors.length ? `Replace the final contiguous trailer block with one final pair:\n${repair}\nThen create or amend the commit explicitly as Engineer. This command never amends or publishes.` : null,
  };
}
