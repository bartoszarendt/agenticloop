/**
 * Minimal files-backed task and decomposition fixtures for the preflight
 * and dispatchability characterization suites.
 *
 * Deliberately small: these cases care about lifecycle and dispatchability
 * boundaries, not about the full dispatch envelope, so the fixture builds the
 * least state that lets `evaluateHandoffPreflight` reach every gate.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../src/canonical-json.js';
import { createDecompositionProvenance } from '../../src/dispatch-envelope.js';
import {
  createTaskInventoryEnumeration,
  evaluateParallelScan,
  normalizeFilesTaskInventory,
} from '../../src/parallel-scan.js';
import { dependencyStatusMap, parseDependencySnapshot } from '../../src/task-evidence-contract.js';

function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function gitOut(target, args) {
  return String(spawnSync('git', args, { cwd: target, encoding: 'utf8' }).stdout ?? '').trim();
}

export function taskPath(target, taskId) {
  return join(target, '.agenticloop', 'tasks', `${taskId}.md`);
}

/** Write one canonical files-backed task record with the requested status. */
export function makePreflightTask(target, taskId, { status = 'agent-ready', dependsOn = [] } = {}) {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  const dependsOnBlock = dependsOn.length === 0
    ? ''
    : ['depends_on:', ...dependsOn.map(id => `  - ${id}`), ''].join('\n');
  writeFileSync(taskPath(target, taskId), `---
task_id: ${taskId}
status: ${status}
backend: files
${dependsOnBlock}allowed_paths:
  - "src/**"
  - "docs/**"
intended_creations:
  - "src/output.txt"
task_contract_schema: 2
---

# ${taskId} - Characterization Task

## Task
Implement the feature.

## Source Documents Reviewed
- README.md

## Current State
Authored for a characterization case.

## Scope
src/** and docs/** only.

## Out of Scope
Everything else.

## Acceptance Criteria
- [ ] Feature works

## Expected Files or Areas
- src/output.txt

## Implementation Notes
Proceed incrementally.

## Required Checks
- [RC-1] command: \`npm test\`

## Completion Summary Template
- Summarize what changed and why.

## Reviewer Checklist
- [ ] Acceptance criteria are met.
`, 'utf8');
  return taskPath(target, taskId);
}

/** Write a committed-shaped decomposition source and its dependency snapshot. */
export function makeDecomposition(target, taskId, {
  workUnitId = `work-unit:${taskId}`,
  dependencyStatuses = {},
  dependencyObservedAt = null,
  inventoryTaskIds = [taskId],
} = {}) {
  const dir = join(target, '.agenticloop', 'decompositions');
  mkdirSync(dir, { recursive: true });
  const sourceRef = `.agenticloop/decompositions/${taskId}.json`;
  const depSourceRef = `.agenticloop/decompositions/${taskId}.dependencies.json`;
  const baseTree = gitOut(target, ['rev-parse', 'HEAD^{tree}']);
  const observedAt = new Date().toISOString();
  // The snapshot's own observation instant may be pushed into the past so a
  // caller can build a genuinely aged snapshot. The scan is still built at
  // `observedAt`, so only the dependency evidence ages.
  const depObservedAt = dependencyObservedAt ?? observedAt;

  const depSnapshotJson = canonicalJson({
    kind: 'agenticloop.dependency-snapshot',
    schemaVersion: 1,
    source: 'files:.agenticloop/tasks',
    observedAt: depObservedAt,
    freshnessPolicy: { maxAgeSeconds: 3600 },
    statuses: dependencyStatuses,
  });
  writeFileSync(join(target, depSourceRef), `${depSnapshotJson}\n`, 'utf8');
  const parsedDep = parseDependencySnapshot(depSnapshotJson, { sourceRef: depSourceRef, now: Date.parse(depObservedAt) });
  if (!parsedDep.ok) throw new Error(`dependency snapshot invalid: ${parsedDep.errors.join('; ')}`);

  const basePaths = gitOut(target, ['ls-tree', '-r', '--name-only', baseTree]).split(/\r?\n/).filter(Boolean);
  const scanned = evaluateParallelScan({
    workUnit: { id: workUnitId, backend: 'files' },
    inventory: normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks',
      entries: inventoryTaskIds.map(id => ({
        carrier: `.agenticloop/tasks/${id}.md`,
        content: readFileSync(taskPath(target, id), 'utf8'),
        readError: null,
      })),
      complete: true,
      enumeration: createTaskInventoryEnumeration({
        backend: 'files',
        inventoryId: 'files:.agenticloop/tasks',
        observedAt,
        discovered: inventoryTaskIds.length,
        returned: inventoryTaskIds.length,
      }),
    }),
    decomposition: {
      source: 'task-decomposition',
      sourceRef,
      revision: 'git-commit:test',
      declaredCompleteness: 'complete',
      attribution: 'maintainer',
      state: 'complete',
    },
    observedAt,
    freshnessPolicy: { maxAgeSeconds: 3600 },
    basePaths,
    dependencies: dependencyStatusMap(parsedDep.evidence),
    readinessContext: {
      base: {
        kind: 'git_tree',
        identity: `git-tree:${baseTree}`,
        inventoryDigest: sha256(canonicalJson([...basePaths].sort())),
        pathCount: basePaths.length,
        revalidationArgs: ['--base', baseTree],
      },
      dependencies: parsedDep.evidence,
    },
    rescanTrigger: 'characterization',
  });
  if (!scanned.ok) throw new Error(`parallel scan failed: ${scanned.result.errors.join('; ')}`);

  writeFileSync(
    join(target, sourceRef),
    `${canonicalJson(createDecompositionProvenance({ taskId, scan: scanned.scan, route: 'serial', sourceRef }))}\n`,
    'utf8'
  );
  return sourceRef;
}
