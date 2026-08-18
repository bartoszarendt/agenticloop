/** Read-only validation and canonical repair guidance for commit attribution. */

import { markdownLines } from './markdown.js';
import { createDiagnostic } from './repair-policy.js';
import { WORKFLOW_ROLE_SET } from './workflow-vocabulary.js';
import { getWorkflowRole } from './workflow-roles.js';
import { isGitObjectId } from './git-oid.js';

const TRAILER_LINE_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\s*:\s*(.+?)\s*$/;
const NAMED_TRAILER_RE = /^(Task|Agent)\s*:\s*(.+?)\s*$/i;

export const ATTRIBUTION_REPAIR_RECORD_KIND = 'agenticloop.attribution-repair';

/**
 * The workflow commit classes Agentic Loop asks a role to author, and the role
 * each one is attributed to.
 *
 * The class decides the role because that is the fact a role kept getting wrong
 * while hand-authoring the one artifact the toolkit is strictest about. It is a
 * closed registry: a commit Agentic Loop does not name here is not a commit it
 * requires, and a missing entry is a gap to add rather than a free-text field.
 */
export const COMMIT_MESSAGE_CLASSES = Object.freeze({
  product_implementation: 'engineer',
  role_start_status: 'engineer',
  implementation_artifact_evidence: 'engineer',
  implementation_summary_evidence: 'engineer',
  implementation_outcome_evidence: 'engineer',
  attempt_abandonment: 'maintainer',
  handoff_evidence_refresh: 'maintainer',
  readiness_settlement: 'maintainer',
  review_record: 'maintainer',
  acceptance_transition: 'maintainer',
  audit_record: 'auditor',
});

export const COMMIT_MESSAGE_CLASS_LIST = Object.freeze(Object.keys(COMMIT_MESSAGE_CLASSES));

/**
 * Render one canonically trailered commit message.
 *
 * This is the single renderer the producer writes with and the repair plan
 * quotes, so a message the toolkit hands out can never be one the toolkit
 * rejects. The trailer pair is the final contiguous block with exactly one
 * blank line before it - which is what `git commit -m … -m …` cannot produce,
 * because it inserts a blank line between *every* `-m` and so leaves `Task:`
 * stranded in its own paragraph outside the final block.
 *
 * @param {{ taskId: string, role: string, subject: string, body?: string|null }} input
 * @returns {{ ok: boolean, errors: string[], message: string|null }}
 */
export function renderCommitMessage({ taskId, role, subject, body = null } = {}) {
  const errors = [];
  const task = String(taskId ?? '').trim();
  const workflowRole = String(role ?? '').trim();
  const subjectLine = String(subject ?? '').trim();
  const bodyText = body === null || body === undefined ? '' : String(body).replace(/\r\n/g, '\n').trim();
  if (!task) errors.push('a commit message requires the task id it is attributed to');
  if (!subjectLine) errors.push('a commit message requires a non-empty subject');
  if (subjectLine.includes('\n')) errors.push('a commit message subject must be a single line');
  if (workflowRole !== workflowRole.toLowerCase()) errors.push(`workflow role identity must be lowercase; received '${workflowRole}'`);
  try {
    getWorkflowRole(workflowRole.toLowerCase());
  } catch {
    errors.push(`unknown workflow role '${workflowRole}'; expected a role from the canonical workflow-role registry`);
  }
  // A Task/Agent line inside the prose becomes a misplaced trailer the moment
  // the canonical block is appended, so it is refused at authoring time rather
  // than reported as a defect after the commit exists.
  if (bodyText.split('\n').some(line => NAMED_TRAILER_RE.test(line.trim()))) {
    errors.push('a commit message body cannot contain its own Task or Agent trailer lines');
  }
  if (errors.length > 0) return { ok: false, errors, message: null };
  const paragraphs = [subjectLine, ...(bodyText ? [bodyText] : []), `Task: ${task}\nAgent: ${workflowRole}`];
  return { ok: true, errors: [], message: `${paragraphs.join('\n\n')}\n` };
}

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
  const suppliedRole = String(role ?? '').trim();
  const expectedRole = suppliedRole.toLowerCase();
  if (!task) errors.push('task id is required for commit attribution');
  if (suppliedRole !== expectedRole) {
    errors.push(`workflow role identity must be lowercase; received '${suppliedRole}'`);
  }
  try {
    getWorkflowRole(expectedRole);
  } catch {
    errors.push(`unknown workflow role '${expectedRole}'; expected a role from the canonical workflow-role registry`);
  }

  const { block, named, misplaced } = parseFinalTrailerBlock(message);
  const tasks = named.filter(entry => entry.name === 'task').map(entry => entry.value);
  const agents = named.filter(entry => entry.name === 'agent').map(entry => entry.value);

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
    diagnostics: errors.map(message => createDiagnostic({
      code: message.startsWith('unknown workflow role') || message.startsWith('workflow role identity')
        ? 'attribution.role'
        : 'attribution.trailer',
      message,
    })),
    repairPlan: errors.length
      ? `Replace the final contiguous trailer block with one final pair:\n${repair}\n` +
        `Or author the whole message with the producer: ${commitMessageProducerHint(task)}\n` +
        `Then create or amend the commit explicitly as ${expectedRole}. This command never amends or publishes.`
      : null,
  };
}

/**
 * The one safe next action for any trailer defect: stop hand-authoring the
 * message.
 *
 * Every refusal that reports a trailer defect quotes this, because the defect
 * is almost never a role's mistake about the grammar - it is `git commit -m …
 * -m …` producing a message the grammar rejects.
 */
export function commitMessageProducerHint(taskId = '<task-id>') {
  return `npx agenticloop task commit-message ${taskId} --class <commit-class> --subject <text> ` +
    '--output <message-file>, then commit with git commit -F <message-file>.';
}
