/**
 * One ordered answer to "what is left before this task can be dispatched?".
 *
 * The two most expensive findings in the field record are the same failure
 * seen from two angles. The Maintainer had no way
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
 * ## Two forms of the same plan
 *
 * Showing the sequence removed the discovery loop but not the *execution* loop:
 * the Maintainer still ran four or five mutation commands and usually produced
 * two commits, and a repair could still invalidate evidence an earlier command
 * had already written. So the plan has a second form.
 *
 * - A **display-only** plan is what you get from current facts alone. It may
 *   show placeholders where an input was never supplied, and it is marked
 *   `applicable: false` with the missing inputs listed in `blockers`.
 * - An **executable** plan additionally binds every exact input a single
 *   readiness transaction needs: the actor, the durable authority, the durable
 *   work-unit identity, resolved base evidence, committed dependency evidence,
 *   the observed task inventory, the expected HEAD, the expected carrier digest,
 *   the exact write set, and the expected predecessor state of every write path.
 *   `planDigest` closes over all of it, so `task readiness-apply` can prove the
 *   facts it is about to mutate are still the facts that were reviewed.
 *
 * Both forms are produced by the same read-only evaluation, and neither writes.
 * The plan is deterministic: repeating it over unchanged facts produces byte
 * identical output, which is why the digest is usable as a staleness test at all.
 *
 * Two things it deliberately does not do:
 *
 * - **It never plans activation.** Activation is the operator's external action
 *   and belongs *after* readiness, which is precisely the ordering the field
 *   record found inverted. A readiness plan that included it would reintroduce the defect.
 * - **It never plans a product-file change.** Readiness settles workflow and
 *   task evidence. A plan that could touch the product would be a plan that
 *   could do the Engineer's work.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { canonicalSha256 } from './canonical-json.js';
import { GIT_MAX_BUFFER } from './git-runner.js';
import { loadFilesTaskContractRecords } from './files-task-contract.js';
import { taskContractDigest, trustedChainTerminal } from './task-contract-baseline.js';
import { taskStatusFromBody } from './dispatchability.js';
import { fingerprintTargetPath } from './fs-mutation-kernel.js';
import { readTaskActivationBinding } from './activation-store.js';
import {
  REPOSITORY_AUTHORITY_IDENTITY_VERSION,
  repositoryAuthorityIdentity,
} from './repository-identity.js';
import { validateTaskStatusTransition } from './task-transition.js';
import { prepareTaskStatusCandidate, taskRecordDigest } from './readiness-candidates.js';

export const READINESS_PLAN_KIND = 'agenticloop.readiness-plan';
export const READINESS_PLAN_SCHEMA_VERSION = 2;

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

/** The subject line of the one final Maintainer readiness commit. */
export const READINESS_COMMIT_SUBJECT = 'settle readiness';

/**
 * The one canonical readiness commit message: a bounded subject and the exact
 * Maintainer trailer pair. Shared so the plan, the apply validator, and the
 * commit itself cannot spell it three ways.
 */
export function readinessCommitMessage(taskId) {
  return `${READINESS_COMMIT_SUBJECT}\n\nTask: ${taskId}\nAgent: maintainer`;
}

/** Every write role a readiness transaction may own. There are exactly three. */
export const READINESS_WRITE_ROLES = Object.freeze([
  'trusted_contract_baseline',
  'committed_decomposition',
  'task_carrier',
]);

/** A readiness write set is workflow evidence only; this is the one root. */
export const READINESS_WRITE_ROOT = '.agenticloop/';

/**
 * Paths a readiness transaction may never write, even though they sit under the
 * workflow root. Activation is the operator action that *follows* readiness.
 */
export const READINESS_FORBIDDEN_WRITE_PREFIXES = Object.freeze([
  '.agenticloop/activation/',
  '.agenticloop/activations/',
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

/** True when any bound executable field still carries an unresolved placeholder. */
export function containsUnresolvedPlaceholder(value) {
  if (typeof value === 'string') return /<[^>]*>/.test(value);
  if (Array.isArray(value)) return value.some(containsUnresolvedPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(containsUnresolvedPlaceholder);
  return false;
}

/** The one canonical readiness plan digest, computed over the closed plan. */
export function readinessPlanDigest(plan) {
  const { planDigest: _planDigest, ...projection } = plan;
  return `sha256:agenticloop.readiness-plan.v${READINESS_PLAN_SCHEMA_VERSION}:${canonicalSha256(projection)}`;
}

/**
 * Digest of exactly which task carriers the observed inventory contains and what
 * bytes each holds. Membership only: the observation instant is excluded so an
 * unchanged plan does not drift, and so the same projection can be recomputed
 * from a prepared decomposition's own member list.
 *
 * @param {Array<{carrier: string, digest: string|null, readable: boolean}>} members
 */
export function readinessInventoryMembershipDigest(members) {
  const projection = [...members]
    .map(member => ({
      carrier: String(member.carrier ?? ''),
      digest: member.digest ?? null,
      readable: member.readable === true,
    }))
    .sort((left, right) => (left.carrier < right.carrier ? -1 : left.carrier > right.carrier ? 1 : 0));
  return `sha256:${canonicalSha256(projection)}`;
}

/** Fingerprint one target-relative path as an explicit predecessor state. */
function predecessorState(target, relPath) {
  let fingerprint;
  try {
    fingerprint = fingerprintTargetPath(target, relPath);
  } catch (error) {
    return { path: relPath, state: 'unreadable', digest: null, reason: error instanceof Error ? error.message : String(error) };
  }
  if (fingerprint === null) return { path: relPath, state: 'absent', digest: null, reason: null };
  if (fingerprint === 'directory') return { path: relPath, state: 'unreadable', digest: null, reason: 'path is a directory' };
  return { path: relPath, state: 'file', digest: `sha256:${fingerprint}`, reason: null };
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
 * @param {{
 *   projectConfig?: object,
 *   actor?: string|null,
 *   authority?: string|null,
 *   workUnitId?: string|null,
 *   base?: {paths: string[], evidence: object}|null,
 *   dependencies?: {evidence: object, statuses: object}|null,
 *   dependencyRef?: string|null,
 *   inventory?: object|null,
 *   freshnessMaxAgeSeconds?: number|null,
 *   rescanTrigger?: string|null,
 *   route?: string|null,
 *   inputBlockers?: string[],
 * }} [options]
 */
export function buildReadinessPlan(target, taskId, options = {}) {
  const projectConfig = options.projectConfig ?? {};
  const relTaskPath = (projectConfig.task_file_template ?? '.agenticloop/tasks/{taskId}.md')
    .replace(/\{taskId\}/g, taskId).replace(/\\/g, '/');
  const taskPath = join(target, relTaskPath);
  const steps = [];
  const blockers = [...(options.inputBlockers ?? [])];

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
  if (!taskExists) blockers.push(`task record ${relTaskPath} does not exist`);
  else if (!contractOk) blockers.push(`task contract is not projectable: ${contract.error}`);

  // 2. The trusted baseline chain. `establish-baseline` appends the payload;
  //    it only becomes trusted after a commit, which is why the plan reports
  //    the commit as part of this step rather than as an afterthought.
  const history = contractOk ? loadFilesTaskContractRecords(target, taskId) : { trustedRecords: [], errors: [] };
  const baselineSettled = contractOk && history.errors.length === 0 && history.trustedRecords.length > 0;
  const historyRef = `.agenticloop/task-contract-history/${taskId}.jsonl`;
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
    writes: baselineSettled ? [] : [historyRef],
  }));
  if (contractOk && history.errors.length) {
    blockers.push(`trusted task-contract history is damaged: ${history.errors[0]}`);
  }

  // The terminal state of the committed chain. A chain whose terminal digest no
  // longer equals the current contract requires a separately authorized
  // correction; readiness must never invent one.
  let contractChain = { state: 'absent', terminalDigest: null, trustedRecordCount: 0 };
  if (contractOk && history.errors.length === 0 && history.trustedRecords.length > 0) {
    const chain = trustedChainTerminal(history.trustedRecords, { taskId });
    if (!chain.ok) {
      contractChain = { state: 'damaged', terminalDigest: null, trustedRecordCount: history.trustedRecords.length };
      blockers.push(`trusted task-contract chain is damaged: ${chain.errors[0]}`);
    } else if (chain.terminalDigest !== contract.digest) {
      contractChain = { state: 'stale', terminalDigest: chain.terminalDigest, trustedRecordCount: history.trustedRecords.length };
      blockers.push(
        'the current task contract differs from the trusted baseline; a separately authorized correction is required ' +
        `(npx agenticloop task authorize-correction ${taskId} --expect-prior-digest ${chain.terminalDigest} ` +
        '--reason <text> --authority <kind:reference> --actor <git-author>)'
      );
    } else {
      contractChain = { state: 'current', terminalDigest: chain.terminalDigest, trustedRecordCount: history.trustedRecords.length };
    }
  } else if (contractOk && history.errors.length) {
    contractChain = { state: 'damaged', terminalDigest: null, trustedRecordCount: 0 };
  }

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
  const boundDependencyRef = decomposition?.scan?.readinessContext?.dependencies?.sourceRef ?? null;
  const dependencyRef = boundDependencyRef ?? (options.dependencyRef ? String(options.dependencyRef).replace(/\\/g, '/') : null);
  const dependencyCommitted = Boolean(boundDependencyRef) && isTrackedAtHead(target, boundDependencyRef);
  const head = git(target, ['rev-parse', 'HEAD']);
  const branch = git(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const suppliedWorkUnit = options.workUnitId ? String(options.workUnitId) : null;
  const baseArgument = options.base?.evidence?.revalidationArgs?.[1] ?? head ?? '<base-ref>';
  const decompositionCommand =
    `npx agenticloop task prepare-decomposition ${taskId} ` +
    `--work-unit ${suppliedWorkUnit ?? decomposition?.scan?.workUnit?.id ?? '<work-unit-id>'} ` +
    `--source-ref ${decompositionRef} --source-revision git-commit:${head ?? '<head>'} ` +
    `--base ${baseArgument} --dependencies ${dependencyRef ?? '<dependencies.json>'}`;

  steps.push(step('dependency_observation', {
    settled: dependencyCommitted,
    detail: boundDependencyRef
      ? (dependencyCommitted ? `committed at ${boundDependencyRef}` : `${boundDependencyRef} is not committed at HEAD`)
      : 'no dependency snapshot is bound by a decomposition',
    owner: 'maintainer',
    dependsOn: ['task_contract'],
    command: dependencyCommitted ? null : decompositionCommand,
    // Only paths that are actually known are listed. Before a decomposition
    // exists the snapshot path is not yet chosen, and putting a placeholder in
    // a write set would make the set unusable for the one thing it is for:
    // seeing exactly what is about to be written.
    writes: dependencyCommitted || !boundDependencyRef ? [] : [boundDependencyRef],
  }));

  const workUnitId = decomposition?.scan?.workUnit?.id ?? null;
  // A synthesized `work-unit:<task-id>` is a fallback, not a durable grouping.
  // Reporting it as settled would hide exactly the scope confusion where a
  // per-task identity is mistaken for a milestone.
  const isDurable = value => Boolean(value) && value !== `work-unit:${taskId}` && value !== taskId;
  const durableWorkUnit = isDurable(workUnitId);
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
  const status = contractOk ? taskStatusFromBody(body) : null;
  const lifecycleSettled = status === 'agent-ready';
  const currentTaskDigest = taskExists ? taskRecordDigest(body) : null;
  // The carrier bytes the readiness commit will contain.
  //
  // This matters more than it looks. One readiness commit settles the lifecycle
  // transition *and* the decomposition, and a parallel scan binds every task
  // carrier digest. A decomposition prepared over the pre-transition draft would
  // therefore be stale against the very commit that introduced it - which is
  // exactly the shape where one repair invalidates another. So the plan
  // binds the prospective carrier, and the decomposition is prepared over it.
  let prospectiveTaskDigest = currentTaskDigest;
  let prospectiveTaskContent = body;
  if (contractOk && !lifecycleSettled) {
    const candidate = prepareTaskStatusCandidate({
      currentContent: body,
      relPath: relTaskPath,
      nextStatus: 'agent-ready',
    });
    if (candidate.ok) {
      prospectiveTaskDigest = candidate.candidateDigest;
      prospectiveTaskContent = candidate.candidate;
    } else {
      prospectiveTaskDigest = null;
      prospectiveTaskContent = null;
      blockers.push(...candidate.errors.map(error => `the agent-ready task candidate is invalid: ${error}`));
    }
  }
  // The paths one readiness commit stages. Exactly the pending readiness
  // evidence, never `-A`: an unrelated staged change must never be able to ride
  // into a Maintainer readiness commit.
  const stagePaths = [
    ...(baselineSettled ? [] : [historyRef]),
    ...(decompositionCommitted ? [] : [decompositionRef]),
    ...(lifecycleSettled ? [] : [relTaskPath]),
  ];
  const finalCommit = readinessCommitMessage(taskId);
  steps.push(step('maintainer_attribution', {
    settled: attributionSettled,
    detail: attributionSettled
      ? 'readiness evidence is committed'
      : 'the readiness evidence above is committed by one Maintainer-attributed commit',
    owner: 'maintainer',
    dependsOn: ['trusted_contract_baseline', 'committed_decomposition'],
    command: attributionSettled
      ? null
      : `git add -- ${stagePaths.join(' ')} && git commit -m "${finalCommit.replace(/\n/g, '\\n')}"`,
  }));

  // 7. The lifecycle transition is last because it consumes everything above:
  //    it validates the committed baseline, the committed dependency snapshot,
  //    and explicit base evidence.
  steps.push(step('lifecycle_agent_ready', {
    settled: lifecycleSettled,
    detail: status ? `current status is '${status}'` : 'the task declares no lifecycle status',
    owner: 'maintainer',
    dependsOn: ['trusted_contract_baseline', 'dependency_observation', 'committed_decomposition', 'maintainer_attribution'],
    command: lifecycleSettled
      ? null
      : `npx agenticloop task status ${taskId} agent-ready --expect-digest ${currentTaskDigest ?? '<digest>'} ` +
        `--base ${baseArgument} --dependencies ${dependencyRef ?? '<dependencies.json>'}`,
    writes: lifecycleSettled ? [] : [relTaskPath],
  }));

  const pending = steps.filter(item => !item.settled);
  const writeSet = [...new Set(pending.flatMap(item => item.writes))].sort();

  // --- The executable binding -------------------------------------------
  //
  // Everything below is the exact input set one readiness transaction consumes.
  // A missing or non-durable input becomes a blocker rather than a placeholder
  // that apply could resolve differently from the reviewer.
  if (!options.actor) blockers.push('an explicit --actor is required; readiness never fabricates a committing identity');
  if (!options.authority) blockers.push('an explicit --authority <kind:reference> is required; readiness never fabricates a human authority');
  const effectiveWorkUnit = suppliedWorkUnit ?? workUnitId;
  if (!effectiveWorkUnit) {
    blockers.push('a durable --work-unit <kind:reference> is required; readiness never synthesizes a work-unit identity');
  } else if (!isDurable(effectiveWorkUnit)) {
    blockers.push(`work-unit identity '${effectiveWorkUnit}' is a per-task fallback, not a durable grouping`);
  }
  if (!options.base) blockers.push('exactly one of --base <ref> or --base-paths <path> is required to resolve exact base evidence');
  if (!options.dependencies) blockers.push('--dependencies <path> naming the exact committed Maintainer-attributed dependency snapshot is required');
  if (!options.inventory) blockers.push('the authoritative task inventory could not be observed');
  else if (options.inventory.complete !== true) blockers.push('the authoritative task inventory is incomplete');
  if (!head) blockers.push('the target has no resolvable HEAD commit');
  if (!branch) blockers.push('readiness apply requires a named branch; HEAD is detached');
  if (contractOk && !lifecycleSettled) {
    const transitionError = validateTaskStatusTransition(status, 'agent-ready', undefined);
    if (transitionError) blockers.push(transitionError);
  }

  const activationRead = readTaskActivationBinding(target, 'files', taskId);
  const activationPresent = activationRead.state === 'present';
  if (activationRead.state === 'malformed') {
    blockers.push(`existing activation binding for '${taskId}' is unreadable: ${activationRead.errors.join('; ')}`);
  }

  const inventoryBinding = options.inventory
    ? {
      inventoryId: String(options.inventory.id ?? ''),
      complete: options.inventory.complete === true,
      // Membership only: the observation instant is deliberately excluded so
      // repeating the plan over unchanged facts stays byte-identical, and so a
      // prepared decomposition's own member list recomputes the same digest.
      observedMembershipDigest: readinessInventoryMembershipDigest(
        (options.inventory.members ?? []).map(member => ({
          carrier: member.carrier,
          digest: member.digest ?? null,
          readable: member.state === 'readable',
        }))
      ),
      // Membership as the readiness commit will leave it: identical except for
      // this task's own carrier, which the same commit transitions.
      membershipDigest: readinessInventoryMembershipDigest(
        (options.inventory.members ?? []).map(member => ({
          carrier: member.carrier,
          digest: member.carrier === relTaskPath ? prospectiveTaskDigest : (member.digest ?? null),
          readable: member.state === 'readable',
        }))
      ),
    }
    : null;

  const writeRoles = [
    ...(baselineSettled ? [] : [{ path: historyRef, role: 'trusted_contract_baseline' }]),
    ...(decompositionCommitted ? [] : [{ path: decompositionRef, role: 'committed_decomposition' }]),
    ...(lifecycleSettled ? [] : [{ path: relTaskPath, role: 'task_carrier' }]),
  ];
  const writes = writeRoles.map(entry => ({
    ...entry,
    ...predecessorState(target, entry.path),
  })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const entry of writes) {
    if (entry.state === 'unreadable') blockers.push(`planned write path '${entry.path}' cannot be fingerprinted: ${entry.reason}`);
    if (!entry.path.startsWith(READINESS_WRITE_ROOT)) blockers.push(`planned write path '${entry.path}' is not workflow or task evidence`);
    if (READINESS_FORBIDDEN_WRITE_PREFIXES.some(prefix => entry.path.startsWith(prefix))) {
      blockers.push(`planned write path '${entry.path}' is activation state; readiness never writes activation`);
    }
  }

  const executable = {
    expectedHead: head,
    expectedTaskDigest: currentTaskDigest,
    repository: {
      authorityIdentity: repositoryAuthorityIdentity(target),
      authorityIdentityVersion: REPOSITORY_AUTHORITY_IDENTITY_VERSION,
      root: repositoryAuthorityIdentity(git(target, ['rev-parse', '--show-toplevel']) ?? target),
      branch,
    },
    task: {
      path: relTaskPath,
      status,
      prospectiveDigest: prospectiveTaskDigest,
      contractDigest: contract?.ok ? contract.digest : null,
      contractProjectionDigest: contract?.ok ? `sha256:${canonicalSha256(contract.projection)}` : null,
    },
    contractChain,
    actor: options.actor ? String(options.actor) : null,
    authority: options.authority ? String(options.authority) : null,
    workUnit: effectiveWorkUnit ? { id: effectiveWorkUnit, backend: 'files' } : null,
    base: options.base
      ? {
        kind: options.base.evidence.kind,
        identity: options.base.evidence.identity,
        inventoryDigest: options.base.evidence.inventoryDigest,
        pathCount: options.base.evidence.pathCount,
        revalidationArgs: [...options.base.evidence.revalidationArgs],
      }
      : null,
    // `evaluatedAt` is deliberately excluded: it is the wall clock at read time
    // and would make an unchanged plan drift on every evaluation.
    dependencies: options.dependencies
      ? {
        sourceRef: options.dependencies.evidence.revalidationArgs[1],
        source: options.dependencies.evidence.source,
        snapshotDigest: options.dependencies.evidence.digest,
        observedAt: options.dependencies.evidence.observedAt,
        freshnessMaxAgeSeconds: options.dependencies.evidence.freshnessPolicy.maxAgeSeconds,
        evaluatedState: options.dependencies.evidence.evaluatedState,
        statusDigest: `sha256:${canonicalSha256(options.dependencies.statuses ?? {})}`,
        provenance: options.dependencies.evidence.provenance ?? null,
        revalidationArgs: [...options.dependencies.evidence.revalidationArgs],
      }
      : null,
    inventory: inventoryBinding,
    decomposition: {
      path: decompositionRef,
      sourceRevision: head ? `git-commit:${head}` : null,
      route: options.route ? String(options.route) : 'serial',
      freshnessMaxAgeSeconds: options.freshnessMaxAgeSeconds ?? null,
      rescanTrigger: options.rescanTrigger ?? null,
    },
    activationPresent,
    predecessorStates: writes.map(entry => ({ path: entry.path, state: entry.state, digest: entry.digest })),
    writes: writes.map(entry => ({ path: entry.path, role: entry.role, state: entry.state, digest: entry.digest })),
    finalCommitMessage: finalCommit,
  };

  if (executable.decomposition.freshnessMaxAgeSeconds === null) {
    blockers.push('the decomposition freshness policy was not supplied');
  }
  if (!executable.decomposition.rescanTrigger) {
    blockers.push('the decomposition semantic rescan trigger was not supplied');
  }
  if (containsUnresolvedPlaceholder(executable)) {
    blockers.push('the bound executable inputs still contain an unresolved placeholder');
  }
  if (pending.length > 0 && containsUnresolvedPlaceholder(pending.map(item => item.command))) {
    blockers.push('a pending step command still contains an unresolved placeholder');
  }

  const uniqueBlockers = [...new Set(blockers)];
  const plan = {
    kind: READINESS_PLAN_KIND,
    schemaVersion: READINESS_PLAN_SCHEMA_VERSION,
    taskId,
    backend: 'files',
    // Read-only is a property of this artifact, not a promise about the caller.
    readOnly: true,
    ready: pending.length === 0,
    // An already-ready task has nothing to apply, so it is applicable in the
    // trivial sense: apply is a proven no-op rather than a refusal.
    applicable: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    steps,
    nextStep: pending[0] ?? null,
    pendingSteps: pending.map(item => item.id),
    // The complete set of paths the remaining steps would write, shown before
    // anything is written.
    writeSet,
    // Every write is workflow or task evidence. A readiness plan that could
    // touch the product would be a plan that could do the Engineer's work.
    writeSetIsWorkflowOnly: writeSet.every(path => path.startsWith(READINESS_WRITE_ROOT)),
    finalCommitTrailer: `Task: ${taskId}\nAgent: maintainer`,
    // Stated so a reader cannot infer that a ready plan means "go".
    activationPlanned: false,
    activationNote: activationPresent
      ? 'An activation binding already exists and is left untouched. Readiness mutation may make its task binding stale; activation is evaluated again only after readiness, and an existing activation is never authorization for readiness mutation.'
      : 'Activation is the operator action that follows readiness; it is never part of this plan.',
    executable,
    planDigest: null,
  };
  plan.planDigest = readinessPlanDigest(plan);
  return Object.freeze({
    ...plan,
    steps: Object.freeze(plan.steps),
    pendingSteps: Object.freeze(plan.pendingSteps),
    writeSet: Object.freeze(plan.writeSet),
    blockers: Object.freeze(plan.blockers),
  });
}
