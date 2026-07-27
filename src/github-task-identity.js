import { parseFrontmatter } from './frontmatter.js';

/**
 * Resolve the one GitHub task identity used in commit attribution.
 *
 * Materialized task frontmatter wins. Older GitHub tasks remain attributable by
 * their linked issue number, and only missing both forms leaves the identity
 * unresolved.
 *
 * @param {any} issueData
 * @returns {{ taskId: string, source: 'frontmatter'|'issue-number' }|null}
 */
export function resolveGitHubTaskIdentity(issueData) {
  const [frontmatter] = parseFrontmatter(String(issueData?.body ?? ''));
  const taskId = typeof frontmatter?.task_id === 'string' ? frontmatter.task_id.trim() : '';
  if (taskId) return { taskId, source: 'frontmatter' };

  const issueNumber = Number(issueData?.number);
  if (Number.isInteger(issueNumber) && issueNumber > 0) {
    return { taskId: `#${issueNumber}`, source: 'issue-number' };
  }
  return null;
}

/** @param {string} taskId @param {string} role */
export function githubAttributionShape(taskId, role) {
  return {
    bodyTrailer: `[[agent: ${role}]]`,
    taskTrailer: `Task: ${taskId}`,
    agentTrailer: `Agent: ${role}`,
  };
}

// ---------------------------------------------------------------------------
// Repository-wide task identity inventory
// ---------------------------------------------------------------------------
//
// GitHub task identity is globally unique within the repository across open
// AND closed issues. Legacy issue-number identities (`#12`) and materialized
// task IDs (`T-012`) occupy distinct namespaces; once any materialized
// identity is present on a carrier, the issue-number fallback cannot mask a
// contradiction between frontmatter, title, and task label. A partial or
// truncated inventory is a non-passing `inventory_incomplete` result, never a
// false uniqueness pass.

const TASK_LABEL_PATTERN = /^task:(.+)$/;

function taskIdPattern(value) {
  if (value instanceof RegExp) return new RegExp(value.source, value.flags.replaceAll('g', ''));
  if (typeof value === 'string' && value.trim()) {
    try { return new RegExp(value.trim()); } catch { return /\bT-\d{3,}\b/; }
  }
  return /\bT-\d{3,}\b/;
}

function isTaskId(value, pattern) {
  pattern.lastIndex = 0;
  return pattern.test(String(value ?? '').trim());
}

function identityFromTitle(title, pattern) {
  for (const token of String(title ?? '').split(/\s+/)) {
    const candidate = token.replace(/^[^A-Za-z0-9#]+|[^A-Za-z0-9._#-]+$/g, '');
    if (candidate && isTaskId(candidate, pattern)) return candidate;
  }
  return '';
}

function identityFromLabels(labels, pattern) {
  const found = [];
  for (const label of labels ?? []) {
    const name = typeof label === 'string' ? label : String(label?.name ?? '');
    const match = name.match(TASK_LABEL_PATTERN);
    if (match && match[1].trim() && isTaskId(match[1], pattern)) found.push(match[1].trim());
  }
  return [...new Set(found)];
}

/**
 * Build one command-local inventory snapshot from a complete issue list.
 * Callers fetch issues once per command (open and closed) and pass the
 * complete array plus truncation metadata; every evaluator in the command
 * reuses this snapshot.
 *
 * @param {object[]} issues  Every open and closed task-candidate issue.
 * @param {{ complete?: boolean, taskIdPattern?: RegExp }} [options]
 *   `complete: false` marks pagination/timeout truncation.
 * @returns {{ complete: boolean, state: string, carriers: Map<string, object[]>, contradictions: object[], errors: string[] }}
 */
export function buildGitHubTaskIdentityInventory(issues, options = {}) {
  const complete = options.complete !== false;
  const pattern = taskIdPattern(options.taskIdPattern ?? options.taskIdRegex);
  const carriers = new Map();
  const contradictions = [];
  const errors = [];

  const addCarrier = (taskId, carrier) => {
    if (!taskId) return;
    const list = carriers.get(taskId) ?? [];
    list.push(carrier);
    carriers.set(taskId, list);
  };

  for (const issue of issues ?? []) {
    const number = Number(issue?.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    const state = String(issue?.state ?? '').toUpperCase() === 'CLOSED' ? 'closed' : 'open';
    const [frontmatter] = parseFrontmatter(String(issue?.body ?? ''));
    const frontmatterId = typeof frontmatter?.task_id === 'string' && isTaskId(frontmatter.task_id, pattern)
      ? frontmatter.task_id.trim()
      : '';
    const titleId = identityFromTitle(issue?.title, pattern);
    const labelIds = identityFromLabels(issue?.labels, pattern);

    const materialized = new Set([frontmatterId, titleId, ...labelIds].filter(Boolean));
    if (labelIds.length > 1) {
      contradictions.push({
        issue: number,
        reason: `issue #${number} carries multiple task labels (${labelIds.join(', ')})`,
      });
    }
    if (materialized.size > 1) {
      // Frontmatter, title, and task label must resolve to one compatible
      // identity. Disagreement fails closed; the issue-number fallback can
      // never mask a contradiction once a materialized identity is present.
      contradictions.push({
        issue: number,
        reason:
          `issue #${number} has contradictory task identities ` +
          `(frontmatter: ${frontmatterId || 'none'}, title: ${titleId || 'none'}, ` +
          `label: ${labelIds.join(', ') || 'none'})`,
      });
    }
    const [taskId] = [...materialized];
    if (taskId) {
      addCarrier(taskId, { number, state, source: frontmatterId ? 'frontmatter' : (titleId ? 'title' : 'label') });
    }
    // The legacy issue-number identity occupies a distinct namespace and is
    // always tracked, so `#12` and `T-012` never collide.
    addCarrier(`#${number}`, { number, state, source: 'issue-number' });
  }

  const duplicates = [];
  for (const [taskId, list] of carriers) {
    if (taskId.startsWith('#')) continue;
    if (list.length > 1) {
      duplicates.push({ taskId, issues: list.map(item => item.number) });
      errors.push(
        `task identity '${taskId}' is carried by ${list.length} issues (${list
          .map(item => `#${item.number} [${item.state}]`)
          .join(', ')}); task identity must be globally unique across open and closed issues`
      );
    }
  }
  for (const contradiction of contradictions) {
    errors.push(contradiction.reason);
  }

  return {
    complete,
    state: complete ? (errors.length > 0 ? 'identity_conflict' : 'ok') : 'inventory_incomplete',
    carriers,
    duplicates,
    contradictions,
    errors,
  };
}

/**
 * Resolve one covered task against the inventory snapshot. The same
 * covered-task invariants apply to files and GitHub backends: existence,
 * uniqueness, and lifecycle state.
 *
 * @param {ReturnType<typeof buildGitHubTaskIdentityInventory>} inventory
 * @param {string} taskId
 * @returns {{ found: boolean, issue: object|null, state: string|null, error: string|null }}
 */
export function resolveCoveredGitHubTask(inventory, taskId) {
  const wanted = String(taskId ?? '').trim();
  if (!inventory?.complete) {
    return { found: false, issue: null, state: null, error: 'inventory_incomplete' };
  }
  const list = inventory.carriers.get(wanted) ?? [];
  if (list.length === 0) {
    return { found: false, issue: null, state: null, error: `covered task '${wanted}' does not exist` };
  }
  if (list.length > 1) {
    return {
      found: false,
      issue: null,
      state: null,
      error: `covered task '${wanted}' is ambiguous across issues ${list.map(item => `#${item.number}`).join(', ')}`,
    };
  }
  return { found: true, issue: list[0], state: list[0].state, error: null };
}
