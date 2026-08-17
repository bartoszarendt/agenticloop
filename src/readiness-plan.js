/**
 * One ordered answer to "what is left before this task can be dispatched?".
 *
 * C12-F2 and C12-F3 are the two most expensive findings in the field record,
 * and they are the same failure seen from two angles. The Maintainer had no way
 * to see the readiness sequence as a sequence: each prerequisite was discovered
 * by failing a gate, repaired, and then invalidated by the repair after it. The
 * measured cost was 23 of 29 preflights failing and 18 of 31 dispatch attempts
 * failing, with activation performed *before* readiness was settled so that
 * every later repair changed facts an earlier observation had already bound.
 *
 * The defect was never that the prerequisites are wrong. Each one guards
 * something real. The defect is that they were only ever presented one failure
 * at a time, in whatever order the gates happened to reach them.
 *
 * So this module computes the whole sequence at once, in dependency order, from
 * current facts. It is strictly read-only: it writes nothing, mutates nothing,
 * and its output is a plan a human or a role can read before doing anything.
 * Every step reports whether it is already settled, what it depends on, who
 * owns it, and - where the command is derivable from current state - the exact
 * command rather than a shape with placeholders.
 *
 * Two things it deliberately does not do:
 *
 * - **It never plans activation.** Activation is the operator's external action
 *   and belongs *after* readiness, which is precisely the ordering C12-F2 found
 *   inverted. A readiness plan that included it would reintroduce the defect.
 * - **It never plans a product-file change.** Readiness settles workflow and
 *   task evidence. A plan that could touch the product would be a plan that
 *   could do the Engineer's work.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { GIT_MAX_BUFFER } from './git-runner.js';
import { loadFilesTaskContractRecords } from './files-task-contract.js';
import { taskContractDigest } from './task-contract-baseline.js';
import { taskStatusFromBody } from './dispatchability.js';

export const READINESS_PLAN_KIND = 'agenticloop.readiness-plan';
export const READINESS_PLAN_SCHEMA_VERSION = 1;

/** The ordered readiness steps. Order is the point of the whole module. */
export const READINESS_STEPS = Object.freeze([
  'task_contract',
  'trusted_contract_baseline',
  'dependency_observation',
  'work_unit_identity',
  'committed_decomposition',
  'maintainer_attribution',
  'lifecycle_agent_ready',
]);

function git(target, args) {
  const result = spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  return result.status === 0 ? String(result.stdout ?? '').trim() : null;
}

function isTrackedAtHead(target, relPath) {
  return git(target, ['cat-file', '-e', `HEAD:${relPath}`]) !== null ||
    git(target, ['rev-parse', `HEAD:${relPath}`]) !== null;
}

function step(id, { settled, detail, owner, dependsOn = [], command = null, writes = [] }) {
  return Object.freeze({
    id,
    settled,
    detail,
    owner,
    dependsOn: Object.freeze([...dependsOn]),
    command,
    writes: Object.freeze([...writes]),
  });
}

/**
 * Compute the readiness plan for one files-backed task.
 *
 * Read-only. Every step is evaluated from current facts, so running this twice
 * with nothing changed produces the same plan, and running it after a repair
 * shows exactly what that repair settled.
 *
 * @param {string} target
 * @param {string} taskId
 * @param {{ projectConfig?: object, actor?: string|null, authority?: string|null }} [options]
 */
export function buildReadinessPlan(target, taskId, options = {}) {
  const projectConfig = options.projectConfig ?? {};
  const relTaskPath = (projectConfig.task_file_template ?? '.agenticloop/tasks/{taskId}.md')
    .replace(/\{taskId\}/g, taskId).replace(/\\/g, '/');
  const taskPath = join(target, relTaskPath);
  const steps = [];

  // 1. The task contract itself. Everything else binds it, so nothing after
  //    this can be evaluated meaningfully if it is absent or malformed.
  const taskExists = existsSync(taskPath);
  const body = taskExists ? readFileSync(taskPath, 'utf8') : null;
  const contract = taskExists ? taskContractDigest(body) : null;
  steps.push(step('task_contract', {
    settled: Boolean(contract?.ok),
    detail: !taskExists
      ? `task record ${relTaskPath} does not exist`
      : (contract.ok ? `contract digest ${contract.digest}` : contract.error),
    owner: 'maintainer',
    command: taskExists ? null : `npx agenticloop task new ${taskId}`,
  }));
  const contractOk = Boolean(contract?.ok);

  // 2. The trusted baseline chain. `establish-baseline` appends the payload;
  //    it only becomes trusted after a commit, which is why the plan reports
  //    the commit as part of this step rather than as an afterthought.
  const history = contractOk ? loadFilesTaskContractRecords(target, taskId) : { trustedRecords: [], errors: [] };
  const baselineSettled = contractOk && history.errors.length === 0 && history.trustedRecords.length > 0;
  steps.push(step('trusted_contract_baseline', {
    settled: baselineSettled,
    detail: history.errors.length
      ? history.errors[0]
      : (baselineSettled
        ? `${history.trustedRecords.length} trusted record(s)`
        : 'no committed trusted task-contract baseline'),
    owner: 'maintainer',
    dependsOn: ['task_contract'],
    command: baselineSettled
      ? null
      : `npx agenticloop task establish-baseline ${taskId} --actor ${options.actor ?? '<git-author>'} --authority ${options.authority ?? '<kind:reference>'}`,
    writes: baselineSettled ? [] : [`.agenticloop/task-contract-history/${taskId}.jsonl`],
  }));

  // 3-5. Dependency observation, work-unit identity, and the committed
  //      decomposition are one authoring act with three outputs, so they are
  //      reported as three steps that share one command. Presenting them
  //      separately is what let the field session repair one and invalidate
  //      the others.
  const decompositionRef = `.agenticloop/decompositions/${taskId}.json`;
  const decompositionPath = join(target, decompositionRef);
  let decomposition = null;
  if (existsSync(decompositionPath)) {
    try {
      decomposition = JSON.parse(readFileSync(decompositionPath, 'utf8'));
    } catch {
      decomposition = null;
    }
  }
  const dependencyRef = decomposition?.scan?.readinessContext?.dependencies?.sourceRef ?? null;
  const dependencyCommitted = Boolean(dependencyRef) && isTrackedAtHead(target, dependencyRef);
  const head = git(target, ['rev-parse', 'HEAD']);
  const decompositionCommand =
    `npx agenticloop task prepare-decomposition ${taskId} --work-unit <work-unit-id> ` +
    `--source-ref ${decompositionRef} --source-revision git-commit:${head ?? '<head>'} ` +
    `--base ${head ?? '<base-ref>'} --dependencies <dependencies.json>`;

  steps.push(step('dependency_observation', {
    settled: dependencyCommitted,
    detail: dependencyRef
      ? (dependencyCommitted ? `committed at ${dependencyRef}` : `${dependencyRef} is not committed at HEAD`)
      : 'no dependency snapshot is bound by a decomposition',
    owner: 'maintainer',
    dependsOn: ['task_contract'],
    command: dependencyCommitted ? null : decompositionCommand,
    // Only paths that are actually known are listed. Before a decomposition
    // exists the snapshot path is not yet chosen, and putting a placeholder in
    // a write set would make the set unusable for the one thing it is for:
    // seeing exactly what is about to be written.
    writes: dependencyCommitted || !dependencyRef ? [] : [dependencyRef],
  }));

  const workUnitId = decomposition?.scan?.workUnit?.id ?? null;
  // A synthesized `work-unit:<task-id>` is a fallback, not a durable grouping.
  // Reporting it as settled would hide exactly the C12-F9 confusion where a
  // per-task identity is mistaken for a milestone.
  const durableWorkUnit = Boolean(workUnitId) && workUnitId !== `work-unit:${taskId}` && workUnitId !== taskId;
  steps.push(step('work_unit_identity', {
    settled: durableWorkUnit,
    detail: workUnitId
      ? (durableWorkUnit ? workUnitId : `${workUnitId} is a per-task fallback, not a durable grouping`)
      : 'no work-unit identity is bound',
    owner: 'maintainer',
    dependsOn: ['task_contract'],
    command: durableWorkUnit ? null : decompositionCommand,
  }));

  const decompositionCommitted = Boolean(decomposition) && isTrackedAtHead(target, decompositionRef);
  steps.push(step('committed_decomposition', {
    settled: decompositionCommitted,
    detail: decomposition
      ? (decompositionCommitted ? `committed at ${decompositionRef}` : `${decompositionRef} is not committed at HEAD`)
      : `${decompositionRef} does not exist or is unreadable`,
    owner: 'maintainer',
    dependsOn: ['task_contract', 'dependency_observation'],
    command: decompositionCommitted ? null : decompositionCommand,
    writes: decompositionCommitted ? [] : [decompositionRef],
  }));

  // 6. Attribution is not a separate authoring act; it is a property the one
  //    readiness commit must have. Naming it as a step is what makes the plan
  //    show a single final commit instead of leaving it implicit.
  const attributionSettled = baselineSettled && decompositionCommitted && dependencyCommitted;
  steps.push(step('maintainer_attribution', {
    settled: attributionSettled,
    detail: attributionSettled
      ? 'readiness evidence is committed'
      : 'the readiness evidence above is committed by one Maintainer-attributed commit',
    owner: 'maintainer',
    dependsOn: ['trusted_contract_baseline', 'committed_decomposition'],
    command: attributionSettled
      ? null
      : `git add -A && git commit -m "settle readiness\n\nTask: ${taskId}\nAgent: maintainer"`,
  }));

  // 7. The lifecycle transition is last because it consumes everything above:
  //    it validates the committed baseline, the committed dependency snapshot,
  //    and explicit base evidence.
  const status = contractOk ? taskStatusFromBody(body) : null;
  const lifecycleSettled = status === 'agent-ready';
  steps.push(step('lifecycle_agent_ready', {
    settled: lifecycleSettled,
    detail: status ? `current status is '${status}'` : 'the task declares no lifecycle status',
    owner: 'maintainer',
    dependsOn: ['trusted_contract_baseline', 'dependency_observation', 'committed_decomposition', 'maintainer_attribution'],
    command: lifecycleSettled
      ? null
      : `npx agenticloop task status ${taskId} agent-ready --expect-digest <digest> ` +
        `--base ${head ?? '<base-ref>'} --dependencies ${dependencyRef ?? '<dependencies.json>'}`,
    writes: lifecycleSettled ? [] : [relTaskPath],
  }));

  const pending = steps.filter(item => !item.settled);
  const writeSet = [...new Set(pending.flatMap(item => item.writes))].sort();

  return Object.freeze({
    kind: READINESS_PLAN_KIND,
    schemaVersion: READINESS_PLAN_SCHEMA_VERSION,
    taskId,
    backend: 'files',
    // Read-only is a property of this artifact, not a promise about the caller.
    readOnly: true,
    ready: pending.length === 0,
    steps: Object.freeze(steps),
    nextStep: pending[0] ?? null,
    pendingSteps: Object.freeze(pending.map(item => item.id)),
    // The complete set of paths the remaining steps would write, shown before
    // anything is written.
    writeSet: Object.freeze(writeSet),
    // Every write is workflow or task evidence. A readiness plan that could
    // touch the product would be a plan that could do the Engineer's work.
    writeSetIsWorkflowOnly: writeSet.every(path => path.startsWith('.agenticloop/')),
    finalCommitTrailer: `Task: ${taskId}\nAgent: maintainer`,
    // Stated so a reader cannot infer that a ready plan means "go".
    activationPlanned: false,
    activationNote: 'Activation is the operator action that follows readiness; it is never part of this plan.',
  });
}
