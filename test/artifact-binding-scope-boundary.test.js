/**
 * Artifact binding asks about the task, and never about the repository.
 *
 * This is the invariant three consecutive fixes lacked. Each of them was
 * locally correct - the path classifier really did misclassify generated host
 * shims, then provisioned line-ending attributes - and each left the same
 * whole-repository question standing somewhere adjacent, where the next shared
 * path a real repository carries found it again. The classifier can only ever
 * enumerate paths the toolkit writes; `package-lock.json` is not one, and there
 * is always a next one.
 *
 * So the boundary is asserted mechanically rather than left to review: the
 * evidence gate that binds `implementation_artifact` reaches for the task's
 * declared surface and for nothing that classifies the repository at large.
 * The classifier keeps its other consumers - return-path classification still
 * needs to know what the toolkit itself wrote - it simply never decides this.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The source lines of one top-level function declaration, brace-matched. */
function functionBody(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex(line =>
    line.startsWith(`function ${name}(`) || line.startsWith(`export function ${name}(`));
  assert.notEqual(start, -1, `no top-level declaration of ${name}`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  assert.ok(end < lines.length, `unterminated declaration of ${name}`);
  return lines.slice(start, end + 1);
}

const BINDING_SOURCE = readFileSync(join(REPO_ROOT, 'src', 'task-cli.js'), 'utf8');

describe('implementation artifact binding is scoped to the task surface', () => {
  for (const name of ['isWorkflowPath', 'createPathClassifier', 'classifyRepositoryPath']) {
    it(`evaluateProductHeadEvidence does not reach for ${name}`, () => {
      const offending = functionBody(BINDING_SOURCE, 'evaluateProductHeadEvidence')
        .filter(line => line.includes(name));
      assert.deepEqual(
        offending.map(line => line.trim()),
        [],
        'binding an implementation artifact is a question about this task, and a ' +
        'repository-wide path classification cannot answer it for any repository ' +
        'that someone else also commits to'
      );
    });
  }

  it('evaluateProductHeadEvidence decides against the declared allowed_paths', () => {
    const body = functionBody(BINDING_SOURCE, 'evaluateProductHeadEvidence').join('\n');
    assert.match(body, /fileMatchesScopePattern/,
      'the surface is matched with the one shared scope matcher, not a second one');
    assert.match(body, /allowedPaths/,
      'the surface comes from the task contract the caller already holds');
  });
});
