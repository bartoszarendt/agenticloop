/**
 * Bounded operational measurement, derived and never stored.
 *
 * The field session was measured from outside and the process was found spending more effort
 * on its own evidence than on the product task: 26 `prepare-return` calls, all
 * failing; 31 `prepare-dispatch` calls, 18 failing; repeated role invocations
 * including empty returns. None of that was visible from inside the run. The
 * remediation asks for those numbers back - but with one constraint that shapes
 * the whole design:
 *
 * > Telemetry is not task evidence and must not become a second workflow truth
 * > store.
 *
 * The cheapest way to honour a constraint is to make violating it impossible,
 * so this module **persists nothing**. Every counter is derived, on demand,
 * from durable evidence that already exists for its own reasons: consumption
 * records, abandonment records, carrier mutation receipts, adoption records.
 * There is no writer here, no schema to drift, and no second place a reader
 * could mistake for the truth. Delete the derived output and nothing is lost.
 *
 * It is also privacy-clean by construction rather than by policy. The inputs
 * are identities, counts, and instants. There is no path by which a prompt,
 * a reasoning trace, a shell log, a diff, or a free-text reason enters a
 * measurement: the reader below never reads a task body, a commit message, or
 * an abandonment's stated reason, and the projection has no field to put one in.
 *
 * What it deliberately does not do: it never decides anything. A deviation from
 * the ordinary shape is reported, not enforced. The operational targets are
 * measurement targets, and a missed target is a fact for a human to weigh, not
 * a gate that blocks work.
 */

import { listCarrierMutationReceipts, listDispatchConsumptions } from './handoff-consumption.js';
import { groupExecutionAttempts, listExecutionAttemptAbandonments } from './execution-attempt.js';
import { listReturnVerifications } from './return-verification.js';
import { parseFilesReviewHistory } from './review-history.js';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadProjectMap } from './project-map.js';
import { taskRecordRelativePath } from './terminal-scope.js';
import { GIT_MAX_BUFFER } from './git-runner.js';
import { commitChangedPaths, createPathClassifier, isWorkflowPath } from './product-lineage.js';

export const WORKFLOW_MEASUREMENT_KIND = 'agenticloop.workflow-measurement';
export const WORKFLOW_MEASUREMENT_SCHEMA_VERSION = 2;

/**
 * The ordinary shape one task should show.
 *
 * Stated as an expectation rather than a limit: the measurement reports how far
 * a task is from this, and reporting is the whole intervention.
 */
export const ORDINARY_TASK_SHAPE = Object.freeze({
  executionAttempts: 1,
  abandonedAttempts: 0,
  engineerOwnedReadinessRepairs: 0,
});

function durationSeconds(fromIso, toIso) {
  const from = Date.parse(fromIso ?? '');
  const to = Date.parse(toIso ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 1000);
}

/**
 * Derive the bounded operational measurement for one task.
 *
 * Read-only. Unreadable evidence is reported as unreadable rather than counted
 * as zero: a measurement that silently reads a broken store as "nothing
 * happened" is worse than no measurement, because it looks like a clean run.
 *
 * @param {string} target
 * @param {string} taskId
 * @param {{ backend?: string, now?: string }} [options]
 */
export function measureTaskWorkflow(target, taskId, options = {}) {
  const backend = options.backend ?? 'files';
  const now = options.now ?? new Date().toISOString();
  const unreadable = [];
  const unavailable = [];

  const consumed = listDispatchConsumptions(target, taskId, { backend });
  if (!consumed.ok) unreadable.push('dispatch_consumption');
  const abandoned = listExecutionAttemptAbandonments(target, taskId);
  if (!abandoned.ok) unreadable.push('execution_attempt_abandonment');
  const mutations = listCarrierMutationReceipts(target, taskId, { backend });
  if (!mutations.ok) unreadable.push('carrier_mutation_receipt');
  const returned = listReturnVerifications(target, taskId);
  if (!returned.ok) unreadable.push('return_verification');

  let reviewEntries = [];
  if (backend === 'files') {
    const config = options.projectConfig ?? loadProjectMap(target)?.config ?? null;
    const carrier = join(target, ...taskRecordRelativePath(config, taskId).split('/'));
    if (existsSync(carrier)) {
      const review = parseFilesReviewHistory(readFileSync(carrier, 'utf8'));
      if (review.errors.length > 0) unreadable.push('review_history');
      else reviewEntries = review.events.filter(event => event.type === 'outcome');
    }
  } else {
    unavailable.push('review_history');
  }

    const groupedAttempts = groupExecutionAttempts({
      consumptions: consumed.records ?? [],
      abandonments: abandoned.records ?? [],
      returns: returned.records ?? [],
      reviews: reviewEntries,
    });
    if (!groupedAttempts.ok) unreadable.push('attempt_binding');
  const attempts = groupedAttempts.records;
  const firstAttempt = attempts[0] ?? null;
  const liveAttempt = attempts.filter(attempt => attempt.state === 'live').at(-1) ?? null;

  // Distinct product bases across attempts is the packet-remint signal: two
  // attempts against the same base are a retry, two against different bases
  // mean work was rebuilt on a base the earlier packet did not describe.
  const distinctProductBases = new Set(attempts.map(attempt => attempt.productBaseHead)).size;
  let commitCounters = { workflowCommits: 'unavailable', productCommits: 'unavailable', totalCommits: 'unavailable' };
  if (firstAttempt?.productBaseHead) {
    const runGit = options.runGit ?? (args => spawnSync('git', args, {
      cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER,
    }));
    const head = runGit(['rev-parse', '--verify', 'HEAD']);
    const currentHead = head?.status === 0 ? String(head.stdout ?? '').trim() : '';
    const ancestry = currentHead
      ? runGit(['merge-base', '--is-ancestor', firstAttempt.productBaseHead, currentHead])
      : null;
    const listed = ancestry?.status === 0
      ? runGit(['rev-list', '--reverse', `${firstAttempt.productBaseHead}..${currentHead}`])
      : null;
    if (listed?.status === 0) {
      const commits = String(listed.stdout ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const classifier = createPathClassifier(target);
      let workflowCommits = 0;
      let productCommits = 0;
      let readable = true;
      for (const commit of commits) {
        const changed = commitChangedPaths(runGit, commit);
        if (!changed.ok) { readable = false; break; }
        if (changed.paths.every(path => isWorkflowPath(path, classifier))) workflowCommits += 1;
        else productCommits += 1;
      }
      if (readable) commitCounters = { workflowCommits, productCommits, totalCommits: commits.length };
    }
  }

  const counters = {
    executionAttempts: attempts.length,
    abandonedAttempts: attempts.filter(attempt => attempt.state === 'abandoned').length,
    liveAttempts: attempts.filter(attempt => attempt.state === 'live').length,
    distinctProductBases,
    // Reminting is attempts beyond the first; it is a count, not a judgement.
    packetRemints: Math.max(0, attempts.length - 1),
    carrierMutations: (mutations.records ?? []).length,
    dispatchConsumptions: (consumed.records ?? []).length,
    physicalAttempts: attempts.length,
    engineeringAttemptBudgetConsumption: attempts.filter(attempt => attempt.engineeringBudgetConsumed === true).length,
    workflowRecoveries: attempts.filter(attempt => attempt.workflowRecovery === true).length,
    reviewRounds: backend === 'files' ? reviewEntries.length : 'unavailable',
    verifiedReturns: (returned.records ?? []).length,
    reviewEntries: backend === 'files' ? reviewEntries.length : 'unavailable',
    workflowCommits: options.workflowCommits ?? commitCounters.workflowCommits,
    productCommits: options.productCommits ?? commitCounters.productCommits,
    totalCommits: options.totalCommits ?? commitCounters.totalCommits,
    physicalHostInvocations: options.physicalHostInvocations ?? 'unavailable',
  };

  const durations = {
    // Only stages whose endpoints are both durable evidence are reported. A
    // stage whose start or end exists only in a transcript is absent rather
    // than estimated - an invented duration is not a measurement.
    firstAttemptToLatestAttemptSeconds: attempts.length > 1
      ? durationSeconds(attempts[0].consumedAt, attempts.at(-1).consumedAt)
      : null,
    liveAttemptElapsedSeconds: liveAttempt ? durationSeconds(liveAttempt.consumedAt, now) : null,
  };

  const deviations = [];
  if (counters.executionAttempts > ORDINARY_TASK_SHAPE.executionAttempts) {
    deviations.push({
      shape: 'executionAttempts',
      expected: ORDINARY_TASK_SHAPE.executionAttempts,
      observed: counters.executionAttempts,
    });
  }
  if (counters.abandonedAttempts > ORDINARY_TASK_SHAPE.abandonedAttempts) {
    deviations.push({
      shape: 'abandonedAttempts',
      expected: ORDINARY_TASK_SHAPE.abandonedAttempts,
      observed: counters.abandonedAttempts,
    });
  }
  if (distinctProductBases > 1) {
    deviations.push({ shape: 'distinctProductBases', expected: 1, observed: distinctProductBases });
  }

  return Object.freeze({
    kind: WORKFLOW_MEASUREMENT_KIND,
    schemaVersion: WORKFLOW_MEASUREMENT_SCHEMA_VERSION,
    taskId,
    backend,
    // Stated in the artifact itself, so a reader who finds this output on disk
    // knows it is a derived view and not a record anything may rely on.
    derived: true,
    persisted: false,
    authority: 'none',
    counters: Object.freeze(counters),
    durations: Object.freeze(durations),
    attempts: Object.freeze(attempts.map(attempt => Object.freeze({
      attemptId: attempt.attemptId,
      sequence: attempt.sequence,
      state: attempt.state,
      consumedAt: attempt.consumedAt,
    }))),
    firstAttemptId: firstAttempt?.attemptId ?? null,
    liveAttemptId: liveAttempt?.attemptId ?? null,
    deviations: Object.freeze(deviations),
    // Unreadable evidence is named, never folded into a zero.
    unreadableEvidence: Object.freeze(unreadable),
    unavailableEvidence: Object.freeze(unavailable),
    complete: unreadable.length === 0,
    observedAt: now,
  });
}

/**
 * Assert that a measurement carries nothing but identities, counts, and
 * instants.
 *
 * The privacy property is structural, but a structural property is only worth
 * as much as the check that keeps it structural. This walks the whole
 * projection and rejects any string long enough or free enough to be prose.
 */
export function assertPrivacyClean(measurement) {
  const violations = [];
  const visit = (value, path) => {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      // Identities, ISO instants, and short enum-like tokens only. Anything
      // longer is prose until proven otherwise.
      if (value.length > 128) violations.push(`${path}: string exceeds the identity/instant length bound`);
      if (/\s{2,}|[.!?]\s/.test(value)) violations.push(`${path}: string reads as prose`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
      return;
    }
    violations.push(`${path}: unsupported value type`);
  };
  visit(measurement, 'measurement');
  return { ok: violations.length === 0, violations };
}
