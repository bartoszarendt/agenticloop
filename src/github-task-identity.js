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
