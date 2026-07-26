import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitHubTaskIdentity } from '../src/github-task-identity.js';
import { validateAttribution } from '../src/github-preflight.js';

describe('GitHub task identity', () => {
  it('uses a non-empty materialized task_id before the issue-number fallback', () => {
    assert.deepEqual(resolveGitHubTaskIdentity({
      number: 42,
      body: '---\ntask_id: T-001\n---\n',
    }), { taskId: 'T-001', source: 'frontmatter' });
  });

  it('uses the linked issue number when legacy frontmatter has no task_id', () => {
    assert.deepEqual(resolveGitHubTaskIdentity({ number: 42, body: '# Legacy task' }), {
      taskId: '#42',
      source: 'issue-number',
    });
  });

  it('is unresolved only without both task identity forms', () => {
    assert.equal(resolveGitHubTaskIdentity({ number: 0, body: '' }), null);
  });

  it('uses the fallback in ordinary attribution diagnostics and validation', () => {
    const body = '## Summary\n\n[[agent: engineer]]';
    const valid = validateAttribution(body, 'subject\n\nTask: #42\nAgent: engineer', {
      number: 42,
      body: '# Legacy task',
    });
    assert.deepEqual(valid.errors, []);

    const invalid = validateAttribution(body, 'subject\n\nTask: T-001\nAgent: engineer', {
      number: 42,
      body: '# Legacy task',
    });
    assert.match(invalid.errors.join('\n'), /expected 'Task: #42'/);
  });
});
