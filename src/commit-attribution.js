/** Read-only validation and canonical repair guidance for commit attribution. */

import { markdownLines } from './markdown.js';

const TRAILER_LINE_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\s*:\s*(.+?)\s*$/;
const NAMED_TRAILER_RE = /^(Task|Agent)\s*:\s*(.+?)\s*$/i;

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
    diagnostics: errors.map(message => ({ message, category: 'attribution', owner: 'engineer', nextAction: 'replace the final contiguous Task/Agent trailer block in the commit message; do not amend automatically' })),
    repairPlan: errors.length ? `Replace the final contiguous trailer block with one final pair:\n${repair}\nThen create or amend the commit explicitly as Engineer. This command never amends or publishes.` : null,
    firstSafeRepair: errors.length ? 'Engineer must replace the final contiguous Task/Agent trailer block explicitly.' : null,
  };
}
