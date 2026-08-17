/**
 * Files-backed fixtures for the P35-C12R.3 readiness-apply suite.
 *
 * The fixture builds only what a readiness transaction genuinely consumes: a
 * task record, a committed Maintainer-attributed dependency snapshot, and a
 * clean tracked worktree. Everything the transaction itself is supposed to
 * produce - the trusted baseline, the decomposition, the lifecycle transition -
 * is deliberately absent, because that is the state C12-F2 and C12-F3 measured.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson } from '../../src/canonical-json.js';
import { createTaskProjectFixture } from './task-fixture.js';
import { git } from './git-fixture.js';
import { makePreflightTask, taskPath } from './c12r-preflight-fixture.js';
import { runCliInProcess } from './run-cli.js';

export const DEPENDENCY_REF = taskId => `.agenticloop/dependencies/${taskId}.json`;
export const HISTORY_REF = taskId => `.agenticloop/task-contract-history/${taskId}.jsonl`;
export const DECOMPOSITION_REF = taskId => `.agenticloop/decompositions/${taskId}.json`;
export const PLAN_REF = taskId => `.agenticloop/tmp/${taskId}-readiness-plan.json`;
export const ACTOR = 'Agentic Loop Test';
export const AUTHORITY = 'plan:P35-C12R';
export const WORK_UNIT = 'milestone:M2';

/** Canonical, committable dependency-status snapshot bytes. */
export function dependencySnapshot({ observedAt = new Date().toISOString(), statuses = {} } = {}) {
  return `${canonicalJson({
    kind: 'agenticloop.dependency-snapshot',
    schemaVersion: 1,
    source: 'files:.agenticloop/tasks',
    observedAt,
    freshnessPolicy: { maxAgeSeconds: 3600 },
    statuses,
  })}\n`;
}

/**
 * A files-backed target with one draft task and a committed dependency snapshot.
 *
 * @param {string} parent  Directory the caller owns.
 * @param {string} name
 * @param {{ taskId?: string, status?: string, snapshot?: string }} [options]
 */
export function createReadinessTarget(parent, name, options = {}) {
  const taskId = options.taskId ?? 'T-018';
  const target = mkdtempSync(join(parent, `${name}-`));
  createTaskProjectFixture(target);
  makePreflightTask(target, taskId, { status: options.status ?? 'draft' });
  mkdirSync(join(target, 'src'), { recursive: true });
  mkdirSync(join(target, 'docs'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'dependencies'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(target, 'src', 'existing.txt'), 'x\n', 'utf8');
  writeFileSync(join(target, 'docs', 'existing.md'), '# d\n', 'utf8');
  writeFileSync(join(target, DEPENDENCY_REF(taskId)), options.snapshot ?? dependencySnapshot(), 'utf8');
  // Transient plan scratch is ignored, so it can never enter a readiness commit.
  writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n', 'utf8');
  git(target, ['add', '-A']);
  git(target, ['commit', '-m', `author ${taskId}\n\nTask: ${taskId}\nAgent: maintainer`]);
  return { target, taskId };
}

export function planArgs(target, taskId, overrides = {}) {
  return [
    'task', 'readiness-plan', taskId,
    '--actor', overrides.actor ?? ACTOR,
    '--authority', overrides.authority ?? AUTHORITY,
    '--work-unit', overrides.workUnit ?? WORK_UNIT,
    '--base', overrides.base ?? 'HEAD',
    '--dependencies', overrides.dependencies ?? DEPENDENCY_REF(taskId),
    '--json', '--target', target,
  ];
}

/** Produce a reviewed executable plan and write it to transient scratch. */
export async function writePlan(target, taskId, overrides = {}) {
  const planned = await runCliInProcess(planArgs(target, taskId, overrides));
  const plan = JSON.parse(planned.stdout);
  writeFileSync(join(target, PLAN_REF(taskId)), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { plan, result: planned };
}

/** Apply a plan file. */
export function applyPlan(target, taskId, mode = '--yes', planRef = null) {
  return runCliInProcess([
    'task', 'readiness-apply', taskId,
    '--plan', planRef ?? PLAN_REF(taskId),
    mode, '--json', '--target', target,
  ]);
}

/** Rewrite the plan file with a mutation applied, without re-deriving it. */
export function tamperPlan(target, taskId, mutate) {
  const path = join(target, PLAN_REF(taskId));
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  mutate(plan);
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return plan;
}

export function taskBody(target, taskId) {
  return readFileSync(taskPath(target, taskId), 'utf8');
}

export function head(target) {
  return git(target, ['rev-parse', 'HEAD']);
}

export function commitCountSince(target, sha) {
  return Number(git(target, ['rev-list', '--count', `${sha}..HEAD`]));
}

export function porcelain(target) {
  return git(target, ['status', '--porcelain', '--untracked-files=all']);
}
