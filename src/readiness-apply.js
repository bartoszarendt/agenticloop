/**
 * One bounded readiness transaction for the files backend.
 *
 * `task readiness-plan` removed the *discovery* loop the field record
 * measured: the Maintainer can now see the whole ordered sequence instead of
 * finding one prerequisite per failed gate. It did not remove the *execution*
 * loop. Settling readiness by hand still meant `establish-baseline`, a commit,
 * `prepare-decomposition` redirected to a file, `task status agent-ready`, and a
 * second commit - because every one of those commands deliberately writes
 * nothing durable and the next one refuses evidence that is not yet committed.
 * Four or five commands, usually two commits, and every repair in the middle
 * able to invalidate what an earlier command had already produced.
 *
 * This module consumes one reviewed executable plan and settles the whole
 * sequence as a single transaction: one filesystem batch through the shared
 * mutation kernel, then at most one Maintainer-attributed commit.
 *
 * The central difficulty is that the baseline, the decomposition, and the
 * lifecycle transition all enter the *same* commit, while the existing
 * validators correctly trust only what HEAD already carries. Nothing here
 * weakens that. Instead the exact candidate bundle is validated prospectively -
 * through `validateTaskContractBaseline`'s existing `prospectiveRecords` seam,
 * which `establish-baseline` already uses to refuse a second baseline - and then
 * the committed result is re-read and re-validated against actual HEAD by the
 * ordinary production gates. Prospective trust exists only inside this bounded
 * transaction and never outlives it.
 *
 * Four properties are structural, not conventions:
 *
 * - **It never activates.** Activation is the operator action that follows
 *   readiness. The write set cannot contain an activation path, and the receipt
 *   states that nothing was activated.
 * - **It never touches a product file.** Every write is workflow or task
 *   evidence under `.agenticloop/`.
 * - **The readiness commit carries exactly the validated write set.** Paths are
 *   staged one literal pathspec at a time, the staged set is compared against
 *   the planned set, and the exact staged tree is captured before the commit;
 *   the created commit's tree must equal that captured tree after every hook
 *   has run. Commit and rollback ownership are bound to the reviewed symbolic
 *   ref, captured before the commit and inspected directly afterward - never
 *   to ambient HEAD, which a hook may have switched. A hook that mutates the
 *   index, adds commits, or switches branches therefore cannot make its
 *   content survive in a readiness commit and cannot have its own commits or
 *   branch rewound by this transaction's rollback: contamination of the one
 *   owned commit is rolled back by a compare-and-swap ref update, and every
 *   other divergence is preserved and reported `unresolved`. `git add -A` is
 *   never used and hooks and signing policy are never bypassed.
 * - **A stale plan cannot mutate.** Every bound input is re-resolved and the
 *   recomputed plan digest is compared before the first write.
 *
 * Idempotence is a proven state, never an assumption: `already_current` is
 * returned only for a fresh ready plan whose facts still match or for a
 * consumed plan whose exact readiness commit is still HEAD, and both forms
 * still pass current applicability, repository safety, and the canonical
 * committed-readiness verification.
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { canonicalJson } from './canonical-json.js';
import { GIT_MAX_BUFFER } from './git-runner.js';
import { evaluateCommitAttribution } from './commit-attribution.js';
import { verifyCommittedAttributedSource } from './committed-source.js';
import { executeMutationBatch, fingerprintTargetPath, resolveTargetPath } from './fs-mutation-kernel.js';
import { repositoryAuthorityIdentity } from './repository-identity.js';
import { prepareDecompositionSource } from './dispatch-envelope.js';
import { readTaskActivationBinding } from './activation-store.js';
import { evaluateHandoffPreflight } from './handoff-preflight.js';
import { isGitObjectId } from './git-oid.js';
import {
  READINESS_FORBIDDEN_WRITE_PREFIXES,
  READINESS_PLAN_KIND,
  READINESS_PLAN_SCHEMA_VERSION,
  READINESS_STEPS,
  READINESS_WRITE_ROLES,
  READINESS_WRITE_ROOT,
  buildReadinessPlan,
  containsUnresolvedPlaceholder,
  readinessCommitMessage,
  readinessInventoryMembershipDigest,
  readinessPlanDigest,
} from './readiness-plan.js';
import {
  evaluateCurrentTaskCarrier,
  prepareAgentReadyEvidence,
  prepareTaskStatusCandidate,
  prepareTrustedBaselineCandidate,
  taskRecordDigest,
} from './readiness-candidates.js';

export const READINESS_APPLY_RECEIPT_KIND = 'agenticloop.readiness-apply-receipt';
export const READINESS_APPLY_RECEIPT_SCHEMA_VERSION = 1;

/**
 * Every disposition one apply attempt can report. `already_current` and
 * `committed` are the only successful ones; the rest are final refusals except
 * `partially_committed` and `unresolved`, which require operator recovery.
 */
export const READINESS_APPLY_DISPOSITIONS = Object.freeze([
  'already_current',
  'committed',
  'dry_run',
  'rolled_back',
  'stale',
  'blocked',
  'partially_committed',
  'unresolved',
]);

const RESOLVED_DISPOSITIONS = new Set([
  'already_current', 'committed', 'dry_run', 'rolled_back', 'stale', 'blocked',
]);

/**
 * Preflight diagnostic families readiness itself owns. After a successful
 * readiness commit none of these may remain. Blockers outside this set -
 * activation above all - are the operator's separate next action, which is
 * exactly why readiness must not claim to have settled them.
 */
export const READINESS_OWNED_PREFLIGHT_CODE_PREFIXES = Object.freeze([
  'task.contract.',
  'task.record.',
  'contract.baseline.',
  'readiness.',
  'scope.',
  'dependency.',
  'parallel_scan.',
  'decomposition.',
  'lifecycle.',
]);

const PLAN_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'taskId', 'backend', 'readOnly', 'ready', 'applicable', 'blockers',
  'steps', 'nextStep', 'pendingSteps', 'writeSet', 'writeSetIsWorkflowOnly', 'finalCommitTrailer',
  'activationPlanned', 'activationNote', 'executable', 'planDigest',
]);
const STEP_FIELDS = Object.freeze(['id', 'settled', 'detail', 'owner', 'dependsOn', 'command', 'writes']);
const EXECUTABLE_FIELDS = Object.freeze([
  'expectedHead', 'expectedTaskDigest', 'repository', 'task', 'contractChain', 'actor', 'authority',
  'workUnit', 'base', 'dependencies', 'inventory', 'decomposition', 'activationPresent',
  'predecessorStates', 'writes', 'finalCommitMessage',
]);
const NESTED_FIELDS = Object.freeze({
  repository: ['authorityIdentity', 'authorityIdentityVersion', 'root', 'branch'],
  task: ['path', 'status', 'prospectiveDigest', 'contractDigest', 'contractProjectionDigest'],
  contractChain: ['state', 'terminalDigest', 'trustedRecordCount'],
  workUnit: ['id', 'backend'],
  base: ['kind', 'identity', 'inventoryDigest', 'pathCount', 'revalidationArgs'],
  dependencies: [
    'sourceRef', 'source', 'snapshotDigest', 'observedAt', 'freshnessMaxAgeSeconds',
    'evaluatedState', 'statusDigest', 'provenance', 'revalidationArgs',
  ],
  inventory: ['inventoryId', 'complete', 'observedMembershipDigest', 'membershipDigest'],
  decomposition: ['path', 'sourceRevision', 'route', 'freshnessMaxAgeSeconds', 'rescanTrigger'],
});
const WRITE_FIELDS = Object.freeze(['path', 'role', 'state', 'digest']);
const PREDECESSOR_FIELDS = Object.freeze(['path', 'state', 'digest']);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[0-9a-f]{64}$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, fields) {
  return isObject(value) && Object.keys(value).length === fields.length &&
    Object.keys(value).every(key => fields.includes(key));
}

function git(target, args) {
  return spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
}

function gitOut(target, args) {
  const result = git(target, args);
  return result.status === 0 ? String(result.stdout ?? '').trim() : null;
}

function gitText(result) {
  return [String(result.stderr ?? '').trim(), String(result.stdout ?? '').trim()]
    .filter(Boolean).join('\n') || `exit ${result.status}`;
}

/** One literal, top-relative pathspec, so a path can never be read as a glob. */
function literalPathspec(path) {
  return `:(top,literal)${path}`;
}

/**
 * Strictly parse one supposedly executable readiness plan.
 *
 * Unknown fields, unsupported versions, a wrong task or repository, an
 * unresolved placeholder, a product path, an activation path, and duplicate or
 * conflicting write entries all fail closed here - before any input is
 * re-resolved and long before anything is written.
 *
 * @param {unknown} plan
 * @param {{ target?: string|null, taskId?: string|null, backend?: string|null }} [context]
 */
export function validateExecutableReadinessPlan(plan, context = {}) {
  const errors = [];
  if (!exactKeys(plan, PLAN_FIELDS)) {
    return { ok: false, errors: ['readiness plan fields must equal the closed schema'] };
  }
  if (plan.kind !== READINESS_PLAN_KIND) errors.push(`readiness plan kind must be '${READINESS_PLAN_KIND}'`);
  if (plan.schemaVersion !== READINESS_PLAN_SCHEMA_VERSION) {
    errors.push(`unsupported readiness plan schemaVersion ${String(plan.schemaVersion)} (expected ${READINESS_PLAN_SCHEMA_VERSION})`);
  }
  if (errors.length > 0) return { ok: false, errors };

  if (context.taskId && plan.taskId !== context.taskId) {
    errors.push(`readiness plan names task '${String(plan.taskId)}', not '${context.taskId}'`);
  }
  if (plan.backend !== 'files') errors.push(`readiness plan backend must be 'files'; readiness apply has no other transactional carrier`);
  if (context.backend && plan.backend !== context.backend) {
    errors.push(`readiness plan backend '${String(plan.backend)}' does not match the selected backend '${context.backend}'`);
  }
  if (plan.readOnly !== true) errors.push('readiness plan readOnly must remain true');
  if (plan.activationPlanned !== false) errors.push('readiness plan activationPlanned must be false; readiness never activates');
  if (typeof plan.ready !== 'boolean') errors.push('readiness plan ready must be a boolean');
  if (plan.applicable !== true) errors.push('readiness plan is display-only; rerun task readiness-plan with every exact apply input');
  if (!Array.isArray(plan.blockers) || plan.blockers.length > 0) {
    errors.push('an applicable readiness plan carries no blockers');
  }
  if (!Array.isArray(plan.steps) || plan.steps.length !== READINESS_STEPS.length ||
      plan.steps.some((item, index) => !exactKeys(item, STEP_FIELDS) || item.id !== READINESS_STEPS[index])) {
    errors.push('readiness plan steps must be the closed ordered readiness sequence');
  }
  if (!Array.isArray(plan.pendingSteps) || plan.pendingSteps.some(id => !READINESS_STEPS.includes(id))) {
    errors.push('readiness plan pendingSteps must name declared readiness steps');
  }
  if (!Array.isArray(plan.writeSet) || plan.writeSet.some(path => typeof path !== 'string' || !path)) {
    errors.push('readiness plan writeSet must be an array of paths');
  }
  if (plan.writeSetIsWorkflowOnly !== true) errors.push('readiness plan write set must be workflow evidence only');
  if (plan.finalCommitTrailer !== `Task: ${String(plan.taskId)}\nAgent: maintainer`) {
    errors.push('readiness plan finalCommitTrailer must be the canonical Maintainer trailer pair');
  }
  if (typeof plan.activationNote !== 'string' || !plan.activationNote) errors.push('readiness plan activationNote is required');

  const executable = plan.executable;
  if (!exactKeys(executable, EXECUTABLE_FIELDS)) {
    errors.push('readiness plan executable binding fields must equal the closed schema');
    return { ok: false, errors };
  }
  for (const [field, fields] of Object.entries(NESTED_FIELDS)) {
    if (!exactKeys(executable[field], fields)) {
      errors.push(`readiness plan executable.${field} fields must equal the closed schema`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  if (!isGitObjectId(executable.expectedHead)) errors.push('readiness plan expectedHead must be an exact Git commit identity');
  if (!DIGEST_RE.test(String(executable.expectedTaskDigest))) errors.push('readiness plan expectedTaskDigest must be a SHA-256 digest');
  if (!CONTRACT_DIGEST_RE.test(String(executable.task.contractDigest))) errors.push('readiness plan task contractDigest must be sha256:v1:<64 hex>');
  if (typeof executable.repository.branch !== 'string' || !executable.repository.branch) {
    errors.push('readiness apply requires a named branch; the plan records a detached HEAD');
  }
  if (context.target) {
    const current = buildRepositoryIdentityFacts(context.target);
    if (executable.repository.authorityIdentity !== current.authorityIdentity) {
      errors.push('readiness plan repository authority identity does not name this target');
    }
    if (executable.repository.root !== current.root) {
      errors.push('readiness plan repository root does not name this target');
    }
  }
  if (executable.contractChain.state !== 'absent' && executable.contractChain.state !== 'current') {
    errors.push(`readiness plan trusted contract chain state '${String(executable.contractChain.state)}' is not applicable`);
  }
  if (typeof executable.actor !== 'string' || !executable.actor.trim()) errors.push('readiness plan requires an explicit actor');
  if (!/^[a-z][a-z0-9_-]*:\s*\S/i.test(String(executable.authority ?? ''))) {
    errors.push('readiness plan requires a durable authority as <kind>:<reference>');
  }
  const workUnitId = String(executable.workUnit?.id ?? '');
  if (!workUnitId || workUnitId === `work-unit:${plan.taskId}` || workUnitId === plan.taskId) {
    errors.push('readiness plan requires a durable work-unit identity, not a per-task fallback');
  }
  if (executable.base.revalidationArgs?.[0] !== '--base' && executable.base.revalidationArgs?.[0] !== '--base-paths') {
    errors.push('readiness plan base evidence must revalidate through --base or --base-paths');
  }
  if (executable.dependencies.revalidationArgs?.[0] !== '--dependencies') {
    errors.push('readiness plan dependency evidence must revalidate through --dependencies');
  }
  if (!isObject(executable.dependencies.provenance) || !isGitObjectId(executable.dependencies.provenance.commit)) {
    errors.push('readiness plan dependency evidence must bind a committed source commit');
  }
  if (executable.inventory.complete !== true) errors.push('readiness plan inventory must be a complete observation');
  if (executable.decomposition.sourceRevision !== `git-commit:${String(executable.expectedHead)}`) {
    errors.push('readiness plan decomposition source revision must bind the expected HEAD');
  }
  if (!Number.isSafeInteger(executable.decomposition.freshnessMaxAgeSeconds) || executable.decomposition.freshnessMaxAgeSeconds <= 0) {
    errors.push('readiness plan decomposition freshness policy must be a positive integer');
  }
  if (executable.finalCommitMessage !== readinessCommitMessage(plan.taskId)) {
    errors.push('readiness plan finalCommitMessage must be the bounded readiness subject and Maintainer trailers');
  }
  const attribution = evaluateCommitAttribution({
    message: executable.finalCommitMessage,
    taskId: plan.taskId,
    role: 'maintainer',
  });
  if (!attribution.ok) errors.push(...attribution.errors.map(error => `readiness plan final commit message: ${error}`));

  // --- the write set -----------------------------------------------------
  if (!Array.isArray(executable.writes)) {
    errors.push('readiness plan writes must be an array');
  } else if (executable.writes.length === 0) {
    // A plan regenerated over an already-settled task legitimately writes
    // nothing. Applying it must stay a proven no-op rather than a refusal, which
    // is what makes rerunning safe.
    if (plan.ready !== true) {
      errors.push('an applicable readiness plan with pending work must bind at least one write');
    }
    if (plan.writeSet.length !== 0 || (executable.predecessorStates ?? []).length !== 0) {
      errors.push('readiness plan writeSet does not equal its bound write paths');
    }
  } else {
    const seenPaths = new Set();
    const seenRoles = new Set();
    for (const entry of executable.writes) {
      if (!exactKeys(entry, WRITE_FIELDS)) { errors.push('readiness plan write entry fields must equal the closed schema'); continue; }
      const path = String(entry.path ?? '');
      if (!isConfinedWorkflowPath(path)) {
        errors.push(`readiness plan write path '${path}' is not a confined target-relative path`);
        continue;
      }
      if (!path.startsWith(READINESS_WRITE_ROOT)) {
        errors.push(`readiness plan write path '${path}' is a product path; readiness writes workflow evidence only`);
      }
      if (READINESS_FORBIDDEN_WRITE_PREFIXES.some(prefix => path.startsWith(prefix))) {
        errors.push(`readiness plan write path '${path}' is activation state; readiness never writes activation`);
      }
      if (seenPaths.has(path)) errors.push(`readiness plan write path '${path}' is duplicated`);
      seenPaths.add(path);
      if (!READINESS_WRITE_ROLES.includes(entry.role)) errors.push(`readiness plan write role '${String(entry.role)}' is unknown`);
      if (seenRoles.has(entry.role)) errors.push(`readiness plan write role '${String(entry.role)}' is duplicated`);
      seenRoles.add(entry.role);
      if (entry.state !== 'absent' && entry.state !== 'file') {
        errors.push(`readiness plan write '${path}' must declare an absent or exact-file predecessor`);
      }
      if (entry.state === 'file' ? !DIGEST_RE.test(String(entry.digest)) : entry.digest !== null) {
        errors.push(`readiness plan write '${path}' predecessor digest does not match its declared state`);
      }
    }
    const planned = [...seenPaths].sort();
    if (canonicalJson(planned) !== canonicalJson([...plan.writeSet].sort())) {
      errors.push('readiness plan writeSet does not equal its bound write paths');
    }
    const predecessors = Array.isArray(executable.predecessorStates) ? executable.predecessorStates : [];
    if (predecessors.some(entry => !exactKeys(entry, PREDECESSOR_FIELDS))) {
      errors.push('readiness plan predecessorStates fields must equal the closed schema');
    } else if (canonicalJson(predecessors) !== canonicalJson(executable.writes.map(entry => ({
      path: entry.path, state: entry.state, digest: entry.digest,
    })))) {
      errors.push('readiness plan predecessorStates do not equal its bound write predecessor states');
    }
    if (executable.writes.some(entry => entry.role === 'task_carrier' && entry.path !== executable.task.path)) {
      errors.push('readiness plan task-carrier write must be the bound task path');
    }
    if (executable.writes.some(entry => entry.role === 'committed_decomposition' && entry.path !== executable.decomposition.path)) {
      errors.push('readiness plan decomposition write must be the bound decomposition path');
    }
  }

  if (containsUnresolvedPlaceholder(executable)) {
    errors.push('an executable readiness plan contains no unresolved placeholders');
  }
  if (plan.planDigest !== readinessPlanDigest(plan)) {
    errors.push('readiness plan digest does not recompute over the plan; the plan was altered after review');
  }
  return { ok: errors.length === 0, errors };
}

function isConfinedWorkflowPath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return !path.split('/').some(segment => !segment || segment === '.' || segment === '..');
}

/**
 * The repository identity facts the plan binds, derived the one way the plan
 * builder derives them so the two can never disagree.
 */
function buildRepositoryIdentityFacts(target) {
  return {
    authorityIdentity: repositoryAuthorityIdentity(target),
    root: repositoryAuthorityIdentity(gitOut(target, ['rev-parse', '--show-toplevel']) ?? target),
  };
}

function result(fields) {
  const receipt = {
    kind: READINESS_APPLY_RECEIPT_KIND,
    schemaVersion: READINESS_APPLY_RECEIPT_SCHEMA_VERSION,
    command: 'task readiness-apply',
    taskId: fields.taskId,
    backend: 'files',
    dryRun: fields.dryRun === true,
    planDigest: fields.planDigest ?? null,
    expectedHead: fields.expectedHead ?? null,
    resultingHead: fields.resultingHead ?? null,
    priorTaskDigest: fields.priorTaskDigest ?? null,
    resultingTaskDigest: fields.resultingTaskDigest ?? null,
    changedPaths: [...(fields.changedPaths ?? [])].sort(),
    commit: fields.commit ?? null,
    commitCount: fields.commitCount ?? 0,
    readiness: fields.readiness ?? null,
    mutationDisposition: fields.mutationDisposition,
    unresolved: !RESOLVED_DISPOSITIONS.has(fields.mutationDisposition),
    activationPlanned: false,
    activationCreated: false,
    errors: [...(fields.errors ?? [])],
    rollbackErrors: [...(fields.rollbackErrors ?? [])],
    nextAction: fields.nextAction ?? null,
    recovery: fields.recovery ?? null,
  };
  return Object.freeze(receipt);
}

function activationGuidance(taskId) {
  return 'Readiness is settled. Activation is the separate operator action that follows it and was not performed: ' +
    `npx agenticloop activate ${taskId} (or --work-unit <id>), then npx agenticloop task handoff-preflight ${taskId} --json.`;
}

/**
 * Parse one `git status --porcelain` line into its status code, its path, and
 * whether the entry is staged (present in the index differing from HEAD).
 * Renames report `orig -> new`; the new path is the one the index holds.
 */
function parsePorcelainEntry(line) {
  const code = line.slice(0, 2);
  const rest = line.slice(3);
  const path = (rest.includes(' -> ') ? rest.split(' -> ')[1] : rest).replace(/^"|"$/g, '');
  return { code, path, staged: code[0] !== ' ' && code[0] !== '?' };
}

/**
 * The one repository-safety precondition for the ordinary apply path.
 *
 * Every staged entry is refused outright - including force-staged scratch under
 * `.agenticloop/tmp/`, because a staged entry is an index mutation and `git add
 * -f` can stage even ignored paths. Only after an entry is proven *not* staged
 * may transient untracked or unstaged scratch under `.agenticloop/tmp/` be
 * ignored. Other worktree-only changes and untracked files are refused, and a
 * planned path is accepted only while its current bytes are exactly the
 * predecessor state the plan bound.
 *
 * Nothing here resets, restores, or discards anything: unsafe state is reported
 * and the operator decides. (Bounded restoration of operation-owned paths is
 * what rollback does on this transaction's own failures - see
 * `restorePredecessors` and `rollbackCreatedCommit`.)
 *
 * `options.writes` overrides the plan's write binding; the proven no-op path
 * uses it to evaluate a consumed plan against an empty binding, because after
 * the readiness commit every path must be clean.
 */
export function evaluateReadinessRepositorySafety(target, plan, options = {}) {
  const status = git(target, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0) {
    return { ok: false, errors: [`the repository state could not be inspected: ${gitText(status)}`] };
  }
  const bound = new Map((options.writes ?? plan.executable?.writes ?? []).map(entry => [entry.path, entry]));
  const errors = [];
  for (const line of String(status.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
    const { path, staged } = parsePorcelainEntry(line);
    // Staged state is refused before any scratch allowance: only untracked or
    // unstaged transient scratch may be ignored, never a staged entry.
    if (staged) {
      errors.push(`'${path}' is staged; readiness apply never commits an index entry it did not plan`);
      continue;
    }
    if (path.startsWith('.agenticloop/tmp/')) continue;
    const entry = bound.get(path);
    if (!entry) {
      errors.push(`'${path}' has uncommitted changes unrelated to this readiness plan`);
      continue;
    }
    let fingerprint;
    try {
      fingerprint = fingerprintTargetPath(target, path);
    } catch (error) {
      errors.push(`planned path '${path}' cannot be fingerprinted: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const state = fingerprint === null ? 'absent' : fingerprint === 'directory' ? 'directory' : 'file';
    const digest = state === 'file' ? `sha256:${fingerprint}` : null;
    if (state !== entry.state || digest !== entry.digest) {
      errors.push(`planned path '${path}' holds bytes the plan did not bind (expected ${entry.state}${entry.digest ? ` ${entry.digest}` : ''})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function stalenessErrors(plan, current) {
  const errors = [];
  const compare = (label, expected, actual) => {
    if (canonicalJson(expected ?? null) !== canonicalJson(actual ?? null)) {
      errors.push(`${label} changed since the plan was reviewed`);
    }
  };
  const planned = plan.executable;
  const now = current.executable;
  if (planned.expectedHead !== now.expectedHead) {
    errors.push(`HEAD moved since the plan was reviewed (${planned.expectedHead} -> ${String(now.expectedHead)})`);
  }
  if (planned.expectedTaskDigest !== now.expectedTaskDigest) {
    errors.push(`the task carrier no longer holds the expected digest ${planned.expectedTaskDigest}`);
  }
  compare('the task lifecycle status', planned.task.status, now.task.status);
  compare('the protected task contract', planned.task.contractDigest, now.task.contractDigest);
  compare('the trusted task-contract chain', planned.contractChain, now.contractChain);
  compare('the committed dependency snapshot', planned.dependencies, now.dependencies);
  compare('the resolved base evidence', planned.base, now.base);
  compare('the observed task inventory', planned.inventory, now.inventory);
  compare('the work-unit identity', planned.workUnit, now.workUnit);
  compare('the decomposition binding', planned.decomposition, now.decomposition);
  compare('the repository identity', planned.repository, now.repository);
  compare('the planned predecessor path states', planned.predecessorStates, now.predecessorStates);
  compare('the planned write set', plan.writeSet, current.writeSet);
  if (errors.length === 0 && plan.planDigest !== current.planDigest) {
    errors.push('the recomputed readiness plan digest differs from the reviewed plan');
  }
  return errors;
}

/**
 * Validate the exact candidate bundle as one semantic unit before any target
 * file is mutated.
 *
 * This is the only place prospective trust exists. It is bounded to this
 * transaction: the same facts are re-validated against actual HEAD after the
 * commit, and nothing here relaxes a committed-evidence rule for any other
 * caller.
 */
function validateProspectiveBundle({ plan, candidates, current }) {
  const errors = [];
  const executable = plan.executable;
  const paths = candidates.map(item => item.path).sort();
  if (canonicalJson(paths) !== canonicalJson([...plan.writeSet].sort())) {
    errors.push('the prepared candidate paths do not equal the reviewed write set');
  }
  for (const candidate of candidates) {
    if (!candidate.path.startsWith(READINESS_WRITE_ROOT)) {
      errors.push(`candidate path '${candidate.path}' is a product path`);
    }
    if (READINESS_FORBIDDEN_WRITE_PREFIXES.some(prefix => candidate.path.startsWith(prefix))) {
      errors.push(`candidate path '${candidate.path}' is activation state`);
    }
  }
  const baseline = candidates.find(item => item.role === 'trusted_contract_baseline');
  if (baseline && baseline.record.digest !== executable.task.contractDigest) {
    errors.push('the baseline candidate does not bind the current protected task contract');
  }
  if (baseline && (baseline.record.actor !== executable.actor || baseline.record.authority !== executable.authority)) {
    errors.push('the baseline candidate does not carry the reviewed actor and authority');
  }
  const decomposition = candidates.find(item => item.role === 'committed_decomposition');
  if (decomposition) {
    const provenance = decomposition.provenance;
    if (provenance.taskId !== plan.taskId) errors.push('the decomposition candidate binds a different task');
    if (provenance.scan?.workUnit?.id !== executable.workUnit.id) errors.push('the decomposition candidate binds a different work unit');
    if (provenance.scan?.readinessContext?.base?.identity !== executable.base.identity) {
      errors.push('the decomposition candidate binds a different base tree');
    }
    if (provenance.scan?.readinessContext?.dependencies?.sourceRef !== executable.dependencies.sourceRef) {
      errors.push('the decomposition candidate binds a different dependency snapshot');
    }
    if (provenance.scan?.inventory?.id !== executable.inventory.inventoryId) {
      errors.push('the decomposition candidate binds a different task inventory');
    }
    if (provenance.scan?.inventory?.complete !== true) {
      errors.push('the decomposition candidate binds an incomplete task inventory');
    }
    const membership = readinessInventoryMembershipDigest((provenance.scan?.inventory?.members ?? []).map(member => ({
      carrier: member.carrier,
      digest: member.digest ?? null,
      readable: member.state === 'readable',
    })));
    if (membership !== executable.inventory.membershipDigest) {
      errors.push('the decomposition candidate binds different task inventory membership');
    }
    if (provenance.scan?.decomposition?.revision !== executable.decomposition.sourceRevision) {
      errors.push('the decomposition candidate binds a different source revision');
    }
    if (provenance.scan?.decomposition?.attribution !== 'maintainer') {
      errors.push('the decomposition candidate is not Maintainer-attributed');
    }
  }
  const carrier = candidates.find(item => item.role === 'task_carrier');
  if (carrier && carrier.nextStatus !== 'agent-ready') {
    errors.push('the task candidate does not transition to agent-ready');
  }
  // One commit with the required trailers must settle every remaining step. The
  // recomputed plan is the authority on what remains.
  const remaining = current.pendingSteps.filter(id => id !== 'maintainer_attribution');
  const settledByBundle = new Set([
    ...(baseline ? ['trusted_contract_baseline'] : []),
    ...(decomposition ? ['dependency_observation', 'work_unit_identity', 'committed_decomposition'] : []),
    ...(carrier ? ['lifecycle_agent_ready'] : []),
  ]);
  for (const id of remaining) {
    if (!settledByBundle.has(id)) errors.push(`step '${id}' would remain unsettled after this transaction`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Apply one reviewed executable readiness plan.
 *
 * @param {{
 *   target: string,
 *   taskId: string,
 *   plan: object,
 *   projectConfig?: object,
 *   dryRun?: boolean,
 *   enumerateInventory: (options?: {observedAt?: string}) => object,
 *   resolveBaseEvidence: (options: object) => {paths: string[], evidence: object},
 *   resolveDependencyEvidence: (relPath: string) => {evidence: object, statuses: object},
 *   io?: {out: Function, err: Function, warn: Function}|null,
 *   now?: number,
 *   recordId?: string|null,
 *   beforeWrite?: Function|null,
 *   afterWrite?: Function|null,
 *   beforeCommit?: Function|null,
 *   beforeRollback?: Function|null,
 *   beforeRefRestore?: Function|null,
 * }} input
 *
 * `beforeWrite`, `afterWrite`, `beforeCommit`, `beforeRollback`, and
 * `beforeRefRestore` are the testable boundaries of the transaction -
 * immediately before the filesystem batch, between the batch and its
 * verification, before the commit, between contamination detection and the
 * commit rollback, and between the rollback's ownership proof and its
 * compare-and-swap ref restoration. Production callers omit them;
 * failure-injection coverage uses them to prove every boundary refuses and
 * restores correctly.
 */
export function applyReadinessPlan(input) {
  const {
    target, taskId, plan, projectConfig = {}, dryRun = false,
    enumerateInventory, resolveBaseEvidence, resolveDependencyEvidence,
    io = null, now = Date.now(), recordId = null,
    beforeWrite = null, afterWrite = null, beforeCommit = null,
    beforeRollback = null, beforeRefRestore = null,
  } = input;

  const refuse = (disposition, errors, extra = {}) => result({
    taskId, dryRun, mutationDisposition: disposition, errors, ...extra,
  });

  // --- 1. Strict plan integrity -----------------------------------------
  const parsed = validateExecutableReadinessPlan(plan, { target, taskId, backend: 'files' });
  if (!parsed.ok) {
    return refuse('blocked', parsed.errors, {
      planDigest: typeof plan?.planDigest === 'string' ? plan.planDigest : null,
      recovery: `Regenerate the plan: npx agenticloop task readiness-plan ${taskId} --json with every exact apply input.`,
    });
  }
  const executable = plan.executable;

  // --- 2. Re-resolve every bound input ----------------------------------
  let base;
  let dependencies;
  let inventory;
  try {
    base = resolveBaseEvidence(
      executable.base.revalidationArgs[0] === '--base'
        ? { base: executable.base.revalidationArgs[1] }
        : { basePaths: executable.base.revalidationArgs[1] }
    );
    dependencies = resolveDependencyEvidence(executable.dependencies.revalidationArgs[1]);
    inventory = enumerateInventory();
  } catch (error) {
    return refuse('stale', [error instanceof Error ? error.message : String(error)], {
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      recovery: `Repair the reported evidence, then regenerate the plan: npx agenticloop task readiness-plan ${taskId} --json ...`,
    });
  }

  const current = buildReadinessPlan(target, taskId, {
    projectConfig,
    actor: executable.actor,
    authority: executable.authority,
    workUnitId: executable.workUnit.id,
    base,
    dependencies,
    dependencyRef: executable.dependencies.sourceRef,
    inventory,
    freshnessMaxAgeSeconds: executable.decomposition.freshnessMaxAgeSeconds,
    rescanTrigger: executable.decomposition.rescanTrigger,
    route: executable.decomposition.route,
  });

  const priorTaskDigest = current.executable.expectedTaskDigest;

  // --- 3. Idempotence: an already-settled task is a *proven* no-op ---------
  //
  // `current.ready` alone is never sufficient. The no-op forms are proven by
  // `verifyCurrentReadinessNoOp`, which still applies current applicability,
  // repository safety, and canonical committed verification before any success
  // receipt exists, and which classifies a moved HEAD as stale, a detached HEAD
  // or other applicability blocker as blocked, and unsafe state as blocked.
  if (current.ready) {
    return verifyCurrentReadinessNoOp({
      target, taskId, plan, current, projectConfig, base, dependencies,
      enumerateInventory, io, dryRun, priorTaskDigest,
    });
  }

  // --- 4. Staleness, before anything is prepared -------------------------
  const stale = stalenessErrors(plan, current);
  if (stale.length > 0) {
    return refuse('stale', stale, {
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      resultingHead: current.executable.expectedHead,
      priorTaskDigest,
      readiness: readinessSummary(current),
      recovery: `Regenerate and review the plan: npx agenticloop task readiness-plan ${taskId} --json ... > <plan.json>`,
    });
  }
  if (!current.applicable) {
    return refuse('blocked', current.blockers, {
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      priorTaskDigest,
      readiness: readinessSummary(current),
      recovery: 'Resolve the reported blocker, then regenerate the plan.',
    });
  }

  // --- 5. Repository safety ---------------------------------------------
  const safety = evaluateReadinessRepositorySafety(target, plan);
  if (!safety.ok) {
    return refuse('blocked', safety.errors, {
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      priorTaskDigest,
      readiness: readinessSummary(current),
      recovery: 'Commit, stash, or revert the reported unrelated changes yourself, then rerun. Readiness apply never resets or discards work it does not own.',
    });
  }

  // --- 6. Candidate preparation, through the shared authorities ----------
  const relTaskPath = executable.task.path;
  const taskAbsolute = resolveWorkflowPath(target, relTaskPath);
  const currentTaskContent = readFileSync(taskAbsolute, 'utf8');
  const roles = new Map(executable.writes.map(entry => [entry.role, entry]));
  const candidates = [];
  const prepareErrors = [];

  let baselineRecord = null;
  if (roles.has('trusted_contract_baseline')) {
    const entry = roles.get('trusted_contract_baseline');
    const historyAbsolute = resolveWorkflowPath(target, entry.path);
    const currentHistory = entry.state === 'file' ? readFileSync(historyAbsolute, 'utf8') : '';
    const prepared = prepareTrustedBaselineCandidate({
      target,
      taskId,
      body: currentTaskContent,
      actor: executable.actor,
      authority: executable.authority,
      timestamp: new Date(now).toISOString(),
      recordId: recordId ?? `files-task-contract:${randomUUID()}`,
      affectedArtifact: relTaskPath,
      currentHistory,
    });
    if (!prepared.ok) prepareErrors.push(...prepared.errors);
    else {
      baselineRecord = prepared.record;
      candidates.push({
        role: 'trusted_contract_baseline',
        path: entry.path,
        predecessor: entry,
        content: prepared.candidate,
        record: prepared.record,
      });
    }
  }

  // The task carrier is prepared before the decomposition, because the
  // decomposition binds every task carrier digest and this same commit changes
  // one of them. Preparing the scan over the pre-transition draft would commit a
  // decomposition that is already stale against its own commit.
  let prospectiveTaskContent = currentTaskContent;
  if (roles.has('task_carrier')) {
    const entry = roles.get('task_carrier');
    const carrier = evaluateCurrentTaskCarrier({
      currentContent: currentTaskContent,
      relPath: relTaskPath,
      taskId,
      nextStatus: 'agent-ready',
    });
    if (!carrier.ok) prepareErrors.push(...carrier.errors);
    else {
      let evidence;
      try {
        evidence = prepareAgentReadyEvidence({
          target,
          taskId,
          relPath: relTaskPath,
          currentContent: currentTaskContent,
          parsedContent: currentTaskContent,
          currentDigest: carrier.currentDigest,
          currentStatus: carrier.currentStatus,
          base,
          dependencies,
          // The one orchestration seam: the baseline entering this same commit
          // satisfies the trusted-chain requirement prospectively.
          prospectiveRecords: baselineRecord ? [baselineRecord] : [],
        });
      } catch (error) {
        evidence = { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
      }
      if (!evidence.ok) prepareErrors.push(...evidence.errors);
      else {
        const candidate = prepareTaskStatusCandidate({
          currentContent: currentTaskContent,
          relPath: relTaskPath,
          nextStatus: 'agent-ready',
        });
        if (!candidate.ok) prepareErrors.push(...candidate.errors);
        else if (candidate.candidateDigest !== executable.task.prospectiveDigest) {
          prepareErrors.push('the prepared agent-ready carrier does not equal the carrier the plan bound');
        } else {
          prospectiveTaskContent = candidate.candidate;
          candidates.push({
            role: 'task_carrier',
            path: entry.path,
            predecessor: entry,
            content: candidate.candidate,
            candidateDigest: candidate.candidateDigest,
            nextStatus: 'agent-ready',
            evidenceContext: evidence.evidenceContext,
          });
        }
      }
    }
  }

  if (roles.has('committed_decomposition') && prepareErrors.length === 0) {
    const entry = roles.get('committed_decomposition');
    // One observation instant for the enumeration receipt and the scan, exactly
    // as `task prepare-decomposition` does: they describe the same observation,
    // so the emitted source is byte-identical for identical inputs.
    const observedAt = new Date(now).toISOString();
    const prepared = prepareDecompositionSource({
      // The producer never receives a caller-supplied inventory: it calls the
      // authoritative enumerator, exactly as `task prepare-decomposition` does.
      // The overlay supplies only the prospective bytes of this task's own
      // carrier; membership and the enumeration receipt are untouched.
      enumerateInventory: () => enumerateInventory({
        observedAt,
        overlay: { [relTaskPath]: prospectiveTaskContent },
      }),
      workUnit: { id: executable.workUnit.id, backend: 'files' },
      taskId,
      sourceRef: executable.decomposition.path,
      sourceRevision: executable.decomposition.sourceRevision,
      route: executable.decomposition.route,
      observedAt,
      freshnessPolicy: { maxAgeSeconds: executable.decomposition.freshnessMaxAgeSeconds },
      basePaths: base.paths,
      dependencies: dependencies.statuses,
      readinessContext: { base: base.evidence, dependencies: dependencies.evidence },
      rescanTrigger: executable.decomposition.rescanTrigger,
    }, { now });
    if (!prepared.ok) prepareErrors.push(...(prepared.validation?.errors ?? ['decomposition candidate preparation failed']));
    else {
      candidates.push({
        role: 'committed_decomposition',
        path: entry.path,
        predecessor: entry,
        content: prepared.source,
        provenance: prepared.decomposition,
      });
    }
  }

  if (prepareErrors.length > 0) {
    return refuse('blocked', prepareErrors, {
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      priorTaskDigest,
      readiness: readinessSummary(current),
      recovery: 'Repair the reported candidate defect, then regenerate the plan. Nothing was written.',
    });
  }

  // --- 7. Prospective whole-bundle validation ----------------------------
  const bundle = validateProspectiveBundle({ plan, candidates, current });
  if (!bundle.ok) {
    return refuse('blocked', bundle.errors, {
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      priorTaskDigest,
      readiness: readinessSummary(current),
      recovery: 'Regenerate the plan; the prepared bundle would not settle the reviewed sequence. Nothing was written.',
    });
  }

  const changedPaths = candidates.map(item => item.path).sort();
  const activationBefore = readTaskActivationBinding(target, 'files', taskId).state;

  if (dryRun) {
    return result({
      taskId,
      dryRun: true,
      mutationDisposition: 'dry_run',
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      resultingHead: null,
      priorTaskDigest,
      resultingTaskDigest: null,
      changedPaths,
      commitCount: 0,
      readiness: readinessSummary(current),
      nextAction: `Nothing was written. Rerun with --yes to settle readiness in one commit: ${executable.finalCommitMessage.split('\n')[0]}.`,
    });
  }

  // --- 8. The filesystem transaction ------------------------------------
  capturePredecessorBytes(target, candidates);
  const mutations = candidates.map(item => (item.predecessor.state === 'absent'
    ? { type: 'create', path: item.path, content: item.content }
    : { type: 'write', path: item.path, content: item.content, expectedDigest: item.predecessor.digest, expectedKind: 'file' }));
  const written = executeMutationBatch(target, mutations, beforeWrite ? { beforeWrite } : {});
  if (!written.ok) {
    const rolledBack = written.rollbackErrors.length === 0;
    return result({
      taskId,
      dryRun,
      mutationDisposition: rolledBack ? 'rolled_back' : 'partially_committed',
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      resultingHead: executable.expectedHead,
      priorTaskDigest,
      resultingTaskDigest: rolledBack ? priorTaskDigest : null,
      changedPaths: rolledBack ? [] : changedPaths,
      commitCount: 0,
      readiness: readinessSummary(current),
      errors: written.errors,
      rollbackErrors: written.rollbackErrors,
      recovery: rolledBack
        ? `The transaction rolled back to its exact predecessor state and created no commit. Repair the reported cause and rerun: npx agenticloop task readiness-plan ${taskId} --json ...`
        : `The filesystem transaction failed and rollback reported errors. Inspect ${changedPaths.join(', ')} before any further mutation: ${written.rollbackErrors.join('; ')}`,
    });
  }

  // --- 9. Refetch the exact written bytes -------------------------------
  try {
    afterWrite?.();
  } catch (error) {
    const rollbackErrors = restorePredecessors(target, candidates);
    const rolledBack = rollbackErrors.length === 0 && candidates.every(item => predecessorMatches(target, item));
    return result({
      taskId,
      dryRun,
      mutationDisposition: rolledBack ? 'rolled_back' : 'unresolved',
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      resultingHead: executable.expectedHead,
      priorTaskDigest,
      resultingTaskDigest: rolledBack ? priorTaskDigest : null,
      changedPaths: rolledBack ? [] : changedPaths,
      commitCount: 0,
      readiness: readinessSummary(current),
      errors: [error instanceof Error ? error.message : String(error)],
      rollbackErrors,
      recovery: rolledBack
        ? 'The transaction rolled back to its exact predecessor state and created no commit.'
        : `The transaction failed after writing and could not be proved restored: ${changedPaths.join(', ')}.`,
    });
  }
  for (const candidate of candidates) {
    const actual = readFileSync(resolveWorkflowPath(target, candidate.path), 'utf8');
    if (actual === candidate.content) continue;
    // Another writer replaced this path. External progress is preserved, never
    // overwritten, and the receipt names the exact path.
    return result({
      taskId,
      dryRun,
      mutationDisposition: 'unresolved',
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      resultingHead: executable.expectedHead,
      priorTaskDigest,
      resultingTaskDigest: null,
      changedPaths,
      commitCount: 0,
      readiness: readinessSummary(current),
      errors: [`'${candidate.path}' was replaced between the write and its verification`],
      recovery: `'${candidate.path}' no longer holds the validated candidate and was left exactly as the other writer left it; ` +
        'the other operation-owned paths were left as written rather than overwriting that progress. ' +
        'Compare them against the plan, decide which content is authoritative, and rerun readiness-plan before any further mutation. No commit was created.',
    });
  }

  // --- 10. Exactly one Maintainer-attributed commit ----------------------
  const restore = () => restorePredecessors(target, candidates, changedPaths, executable.expectedHead);
  // The reviewed ref and its actual state, read from the repository rather
  // than assumed: every receipt below derives its heads and counts from these.
  const commitState = ref => ({
    head: ref ? gitOut(target, ['rev-parse', '--verify', ref]) : null,
    count: ref ? countCommitsAboveRef(target, ref, executable.expectedHead) : null,
  });

  const commitOutcome = createReadinessCommit({
    target, plan, candidates, changedPaths, beforeCommit,
  });
  if (!commitOutcome.ok) {
    if (commitOutcome.worldDiverged) {
      // git commit refused AND a hook moved HEAD away from the reviewed
      // branch. Nothing is rolled back in this state - restoration could act
      // on the wrong branch - so every ref, index entry, and written file is
      // preserved exactly and handed to the operator.
      const state = commitState(commitOutcome.originalRef);
      return result({
        taskId,
        dryRun,
        mutationDisposition: 'unresolved',
        planDigest: plan.planDigest,
        expectedHead: executable.expectedHead,
        resultingHead: state.head,
        priorTaskDigest,
        resultingTaskDigest: taskRecordDigest(readFileSync(taskAbsolute, 'utf8')),
        changedPaths,
        commitCount: state.count ?? 0,
        readiness: readinessSummary(current),
        errors: commitOutcome.errors,
        recovery: 'The commit was refused while HEAD had already moved away from the reviewed branch. ' +
          'Nothing was rolled back, unstaged, or discarded: every ref, the staged entries, and the written candidate files were preserved exactly. ' +
          'Inspect the current branch and the reported paths, then rerun readiness-plan.',
      });
    }
    if (commitOutcome.contaminated) {
      // This transaction's own commit was created but is not the reviewed
      // commit: a hook mutated the candidate index (an unplanned path or
      // rewritten planned bytes entered the tree) or rewrote the message.
      if (!commitOutcome.rollbackable) {
        // The world no longer shows exactly the created commit - a hook
        // switched branches or the ref moved - so even this transaction's own
        // invalid commit is preserved rather than rewritten.
        const state = commitState(commitOutcome.originalRef);
        return result({
          taskId,
          dryRun,
          mutationDisposition: 'unresolved',
          planDigest: plan.planDigest,
          expectedHead: executable.expectedHead,
          resultingHead: state.head ?? commitOutcome.head,
          priorTaskDigest,
          resultingTaskDigest: taskRecordDigest(readFileSync(taskAbsolute, 'utf8')),
          changedPaths,
          commitCount: state.count ?? 1,
          readiness: readinessSummary(current),
          errors: commitOutcome.errors,
          recovery: `An invalid readiness commit (${String(commitOutcome.head)}) exists, but the repository moved after it was created, so it was preserved rather than rolled back. ` +
            'Inspect it and the reported paths before any further mutation; do not reuse this plan.',
        });
      }
      let rollback;
      try {
        beforeRollback?.();
        rollback = rollbackCreatedCommit({
          target, originalRef: commitOutcome.originalRef,
          expectedHead: executable.expectedHead, createdHead: commitOutcome.head,
          candidates, changedPaths, beforeRefRestore,
        });
      } catch (error) {
        rollback = {
          errors: [`the rollback was interrupted: ${error instanceof Error ? error.message : String(error)}`],
          unplannedPaths: [],
        };
      }
      const state = commitState(commitOutcome.originalRef);
      const rolledBack = rollback.errors.length === 0 &&
        state.head === executable.expectedHead && state.count === 0 &&
        candidates.every(item => predecessorMatches(target, item));
      const leftover = rollback.unplannedPaths.length > 0
        ? ` Hook-modified worktree state was left untouched for the operator: ${rollback.unplannedPaths.join(', ')}.`
        : '';
      return result({
        taskId,
        dryRun,
        mutationDisposition: rolledBack ? 'rolled_back' : 'unresolved',
        planDigest: plan.planDigest,
        expectedHead: executable.expectedHead,
        resultingHead: state.head ?? (rolledBack ? executable.expectedHead : commitOutcome.head),
        priorTaskDigest,
        resultingTaskDigest: rolledBack ? priorTaskDigest : null,
        changedPaths: rolledBack ? [] : changedPaths,
        commitCount: state.count ?? (rolledBack ? 0 : 1),
        readiness: readinessSummary(current),
        errors: [...commitOutcome.errors, ...rollback.errors],
        rollbackErrors: rollback.errors,
        recovery: rolledBack
          ? `No readiness commit exists: the created commit did not carry the exact validated content and was rolled back by a compare-and-swap ref update. The reviewed ref points at ${executable.expectedHead} again, the index entries it changed were restored per path, and the operation-owned paths hold their exact predecessor state.${leftover} Repair or remove the hook's commit mutation, then rerun: npx agenticloop task readiness-plan ${taskId} --json ...`
          : `An invalid readiness commit could not be proved rolled back, and every ref and commit was preserved. Inspect the reported paths before any further mutation; do not reuse this plan.${leftover}`,
      });
    }
    if (commitOutcome.committed) {
      // Commits exist on the reviewed ref that are not this transaction's
      // alone, or the commit landed away from it. They are never reset or
      // rewritten automatically: the evidence is preserved and handed over.
      return result({
        taskId,
        dryRun,
        mutationDisposition: 'unresolved',
        planDigest: plan.planDigest,
        expectedHead: executable.expectedHead,
        resultingHead: commitOutcome.head ?? null,
        priorTaskDigest,
        resultingTaskDigest: taskRecordDigest(readFileSync(taskAbsolute, 'utf8')),
        changedPaths,
        commit: commitOutcome.commit ?? null,
        commitCount: commitOutcome.observedCommitCount ?? 1,
        readiness: readinessSummary(current),
        errors: commitOutcome.errors,
        recovery: commitOutcome.recovery ??
          `Readiness commits exist that this transaction cannot account for (${String(commitOutcome.head)}). They were deliberately not reset or rewritten. ` +
          `Inspect them, then repair through the ordinary Maintainer route: npx agenticloop task readiness-plan ${taskId} --json ...`,
      });
    }
    const rollbackErrors = restore();
    const rolledBack = rollbackErrors.length === 0 &&
      candidates.every(item => predecessorMatches(target, item));
    return result({
      taskId,
      dryRun,
      mutationDisposition: rolledBack ? 'rolled_back' : 'unresolved',
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      resultingHead: executable.expectedHead,
      priorTaskDigest,
      resultingTaskDigest: rolledBack ? priorTaskDigest : null,
      changedPaths: rolledBack ? [] : changedPaths,
      commitCount: 0,
      readiness: readinessSummary(current),
      errors: commitOutcome.errors,
      rollbackErrors,
      recovery: rolledBack
        ? `No commit was created and the operation-owned paths were restored to their exact predecessor state. Repair the reported cause and rerun: npx agenticloop task readiness-plan ${taskId} --json ...`
        : `No commit was created, but the operation-owned paths could not be proved restored: ${changedPaths.join(', ')}. Inspect them before any further mutation.`,
    });
  }

  // --- 11. Post-commit canonical verification ---------------------------
  const verification = verifyCommittedReadiness({
    target, taskId, projectConfig, plan, base, dependencies, enumerateInventory, io,
    activationBefore,
  });
  const resultingTaskDigest = taskRecordDigest(readFileSync(taskAbsolute, 'utf8'));
  if (!verification.ok) {
    return result({
      taskId,
      dryRun,
      mutationDisposition: 'unresolved',
      planDigest: plan.planDigest,
      expectedHead: executable.expectedHead,
      resultingHead: commitOutcome.head,
      priorTaskDigest,
      resultingTaskDigest,
      changedPaths,
      commit: commitOutcome.commit,
      commitCount: 1,
      readiness: verification.readiness,
      errors: verification.errors,
      recovery: `The readiness commit ${commitOutcome.head} exists but the ordinary post-commit gates do not report readiness. ` +
        'The commit was deliberately not reset or rewritten. Repair the reported cause as the Maintainer before dispatch.',
    });
  }

  return result({
    taskId,
    dryRun,
    mutationDisposition: 'committed',
    planDigest: plan.planDigest,
    expectedHead: executable.expectedHead,
    resultingHead: commitOutcome.head,
    priorTaskDigest,
    resultingTaskDigest,
    changedPaths,
    commit: commitOutcome.commit,
    commitCount: 1,
    readiness: verification.readiness,
    nextAction: activationGuidance(taskId),
  });
}

/**
 * Prove - never assume - that applying over an already-settled task is a no-op.
 *
 * Exactly two forms may return `already_current`:
 *
 * - **A fresh ready plan** (empty write set) whose digest and bound facts still
 *   match the recomputed plan over the current HEAD.
 * - **A consumed executable plan** whose exact readiness commit is still HEAD.
 *   Its expected HEAD necessarily predates its own readiness commit, so generic
 *   equality-based staleness would refuse it; only the explicit
 *   `proveConsumedReadinessCommit` proof justifies the no-op.
 *
 * Both forms still pass, in order: current applicability (a named branch above
 * all - a detached HEAD blocks even a no-op), the no-op form's own proof or
 * staleness check, repository safety, and the canonical committed-readiness
 * verification. A stale, blocked, or unsafe result never carries activation
 * guidance.
 */
function verifyCurrentReadinessNoOp({
  target, taskId, plan, current, projectConfig, base, dependencies,
  enumerateInventory, io, dryRun, priorTaskDigest,
}) {
  const executable = plan.executable;
  const refuse = (disposition, errors, extra = {}) => result({
    taskId,
    dryRun,
    mutationDisposition: disposition,
    errors,
    planDigest: plan.planDigest,
    expectedHead: executable.expectedHead,
    priorTaskDigest,
    readiness: readinessSummary(current),
    ...extra,
  });

  // Current applicability gates a no-op exactly as it gates mutation.
  if (!current.applicable) {
    return refuse('blocked', current.blockers, {
      recovery: 'Resolve the reported blocker, then regenerate the plan.',
    });
  }

  if (executable.writes.length > 0) {
    // Form B: the consumed plan. Only the explicit proof below can justify a
    // no-op; a later HEAD movement is stale, not current.
    const proof = proveConsumedReadinessCommit(target, plan);
    if (!proof.ok) {
      return refuse('stale', proof.errors, {
        resultingHead: proof.head,
        recovery: `The plan was consumed or superseded; regenerate and review it: npx agenticloop task readiness-plan ${taskId} --json ... > <plan.json>`,
      });
    }
  } else {
    // Form A: a fresh ready plan over the current HEAD; generic staleness
    // applies directly.
    const stale = stalenessErrors(plan, current);
    if (stale.length > 0) {
      return refuse('stale', stale, {
        resultingHead: current.executable.expectedHead,
        recovery: `Regenerate and review the plan: npx agenticloop task readiness-plan ${taskId} --json ... > <plan.json>`,
      });
    }
  }

  // Repository safety still applies to no-op execution. A consumed plan's
  // predecessor bindings describe the pre-transaction state, so its rerun is
  // evaluated against an empty binding: after the readiness commit every path
  // must be clean, and any dirt is unrelated to a no-op.
  const safety = evaluateReadinessRepositorySafety(
    target, plan, executable.writes.length > 0 ? { writes: [] } : {});
  if (!safety.ok) {
    return refuse('blocked', safety.errors, {
      recovery: 'Commit, stash, or revert the reported unrelated changes yourself, then rerun. Readiness apply never resets or discards work it does not own.',
    });
  }

  // Canonical committed verification: the same gates a fresh commit must pass.
  // This re-runs the readiness plan against actual HEAD, verifies the committed
  // decomposition and dependency snapshot as exact Maintainer-attributed
  // sources, proves no readiness-owned preflight blocker remains, and checks
  // the worktree is clean - so an `already_current` receipt means readiness is
  // genuinely settled, not merely that the lifecycle field says so.
  const activationNow = readTaskActivationBinding(target, 'files', taskId).state;
  const verification = verifyCommittedReadiness({
    target, taskId, projectConfig, plan, base, dependencies, enumerateInventory, io,
    activationBefore: activationNow,
  });
  if (!verification.ok) {
    return refuse('blocked', verification.errors, { readiness: verification.readiness });
  }

  return result({
    taskId,
    dryRun,
    mutationDisposition: 'already_current',
    planDigest: plan.planDigest,
    expectedHead: executable.expectedHead,
    // Truthful heads: the current HEAD - which for a consumed plan is the
    // readiness commit that consumed it.
    resultingHead: current.executable.expectedHead,
    priorTaskDigest,
    resultingTaskDigest: priorTaskDigest,
    changedPaths: [],
    commitCount: 0,
    readiness: verification.readiness,
    nextAction: activationGuidance(taskId),
  });
}

/**
 * The explicit consumed-plan proof (no-op form B).
 *
 * Establishes that HEAD *is* the exact readiness commit this plan produced:
 *
 * - HEAD's parent is the plan's `expectedHead`, so the readiness commit is
 *   HEAD - no later commit or carrier mutation has occurred;
 * - HEAD carries the plan's exact final commit message and Maintainer
 *   attribution, so a same-position foreign commit cannot impersonate it;
 * - HEAD's committed path set equals the plan's exact write set, so no
 *   unplanned path - a hook-injected product path or an activation - is part
 *   of the readiness that is being claimed current.
 *
 * The repository identity facts were validated against the target at parse
 * time. Semantic freshness beyond this shape (the agent-ready status, the
 * trusted chain, committed decomposition and dependency evidence, preflight
 * blockers) is not duplicated here: `verifyCommittedReadiness` re-runs the
 * canonical validators over actual HEAD once this proof passes.
 */
function proveConsumedReadinessCommit(target, plan) {
  const executable = plan.executable;
  const head = gitOut(target, ['rev-parse', 'HEAD']);
  if (!isGitObjectId(head)) {
    return { ok: false, head: null, errors: ['the current HEAD cannot be resolved'] };
  }
  const parent = gitOut(target, ['rev-parse', `${head}^`]);
  if (parent !== executable.expectedHead) {
    return {
      ok: false,
      head,
      errors: [
        `HEAD moved since the plan was consumed (${executable.expectedHead} -> ${head}); the plan's readiness commit is no longer HEAD`,
      ],
    };
  }
  const errors = [];
  const message = gitOut(target, ['show', '-s', '--format=%B', head]);
  if (message !== executable.finalCommitMessage) {
    errors.push('the commit at the readiness position does not carry the reviewed final commit message');
  }
  const attribution = evaluateCommitAttribution({ message, taskId: plan.taskId, role: 'maintainer' });
  if (!attribution.ok) {
    errors.push(...attribution.errors.map(error => `the commit at the readiness position is not the plan's commit: ${error}`));
  }
  const diff = git(target, ['diff-tree', '--no-commit-id', '--name-only', '-r', head]);
  const changed = diff.status === 0
    ? String(diff.stdout ?? '').split(/\r?\n/).filter(Boolean).sort()
    : null;
  if (changed === null) {
    errors.push('the readiness commit path set could not be read');
  } else if (canonicalJson(changed) !== canonicalJson([...plan.writeSet].sort())) {
    errors.push(`the commit at the readiness position changed ${JSON.stringify(changed)} rather than the plan's exact write set ${JSON.stringify([...plan.writeSet].sort())}`);
  }
  return { ok: errors.length === 0, head, errors };
}

/**
 * Restore only the operation-owned paths - and, when a path set is supplied, only
 * their index entries - to their exact predecessor state.
 *
 * Nothing outside `candidates` is touched: no whole-repository reset, no
 * unrelated path, no discarded work. The index restoration is deliberately
 * narrow - `git reset <anchor> -- <literal pathspec>` per operation-owned
 * path, anchored to the transaction's expected HEAD explicitly rather than to
 * ambient HEAD - and no broad or destructive reset (`--hard`,
 * repository-wide) is performed anywhere in this module.
 */
function restorePredecessors(target, candidates, changedPaths = null, anchor = 'HEAD') {
  const rollback = executeMutationBatch(target, candidates.map(item => (item.predecessor.state === 'absent'
    ? { type: 'remove', path: item.path }
    : { type: 'write', path: item.path, content: item.predecessorBytes })));
  const errors = [...rollback.errors, ...rollback.rollbackErrors];
  if (changedPaths !== null) {
    const unstaged = git(target, ['reset', '--quiet', anchor, '--', ...changedPaths.map(literalPathspec)]);
    if (unstaged.status !== 0) errors.push(`index restore: ${gitText(unstaged)}`);
  }
  return errors;
}

/** Capture the exact predecessor bytes of every operation-owned path. */
function capturePredecessorBytes(target, candidates) {
  for (const candidate of candidates) {
    candidate.predecessorBytes = candidate.predecessor.state === 'file'
      ? readFileSync(resolveWorkflowPath(target, candidate.path), 'utf8')
      : null;
  }
}

/** The kernel owns path confinement; this is the read-side spelling of it. */
function resolveWorkflowPath(target, relPath) {
  return resolveTargetPath(target, relPath);
}

function predecessorMatches(target, candidate) {
  let fingerprint;
  try {
    fingerprint = fingerprintTargetPath(target, candidate.path);
  } catch {
    return false;
  }
  if (candidate.predecessor.state === 'absent') return fingerprint === null;
  return fingerprint !== null && `sha256:${fingerprint}` === candidate.predecessor.digest;
}

function readinessSummary(plan) {
  return Object.freeze({
    ready: plan.ready,
    pendingSteps: [...plan.pendingSteps],
    status: plan.executable.task.status,
    writeSet: [...plan.writeSet],
  });
}

/**
 * Stage exactly the planned literal paths and create one commit whose tree is
 * exactly the validated candidate tree, with ownership bound to the reviewed
 * ref.
 *
 * Which index, tree, and ref are authoritative, and when hooks run:
 *
 * - The authoritative tree is captured from the index *after* staging:
 *   repository safety proved the index held nothing but HEAD, the staging added
 *   exactly the planned paths one literal pathspec at a time, and the staged
 *   set was compared against the planned set. `git write-tree` freezes that
 *   exact state as the tree the commit must carry.
 * - The authoritative *ref* is the full symbolic ref HEAD names, captured with
 *   its exact OID immediately before `git commit` is invoked. Every judgment
 *   after the hooks reads THIS ref - never ambient HEAD, which a hook may have
 *   switched to another branch.
 * - The commit is an ordinary `git commit`, so every hook the repository
 *   configures (pre-commit through post-commit) runs exactly as the operator
 *   set it, and signing policy (including `commit.gpgsign`) applies unchanged -
 *   `--no-verify` is never used and no commit flags are overridden.
 * - After `git commit` returns - after every hook capable of changing the
 *   candidate index, the ref, or the ambient branch - the reviewed ref is
 *   inspected in this order: (1) did it move at all; (2) does it hold exactly
 *   ONE commit directly above the expected HEAD. Count and ancestry come
 *   BEFORE any tree or message classification, so a post-commit hook that
 *   added another commit (changed-tree or same-tree) can never be mistaken
 *   for contamination of this transaction's own commit - the whole sequence is
 *   preserved and reported `unresolved`.
 * - Only when the reviewed ref holds exactly this transaction's direct child
 *   is the content validated: the commit's tree must equal the captured tree
 *   and its message and attribution must equal the reviewed message. A divergent
 *   commit is the transaction's own and is rolled back narrowly
 *   (`rollbackCreatedCommit`) - but only while the world still shows exactly
 *   it: the reviewed ref at the created commit AND ambient HEAD still on that
 *   ref. A hook that switched branches leaves the invalid commit in place,
 *   preserved, reported `unresolved`.
 * - On hook refusal `git commit` creates nothing; the ordinary bounded rollback
 *   (`restorePredecessors`) restores the operation-owned paths and their index
 *   entries - unless the hook also moved HEAD away from the reviewed branch,
 *   in which case nothing is touched and everything is preserved.
 */
function createReadinessCommit({ target, plan, candidates, changedPaths, beforeCommit }) {
  const executable = plan.executable;
  try {
    beforeCommit?.();
  } catch (error) {
    return { ok: false, committed: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const head = gitOut(target, ['rev-parse', 'HEAD']);
  if (head !== executable.expectedHead) {
    return { ok: false, committed: false, errors: [`HEAD moved to ${String(head)} after the filesystem transaction; no commit was created`] };
  }
  for (const candidate of candidates) {
    if (readFileSync(resolveWorkflowPath(target, candidate.path), 'utf8') !== candidate.content) {
      return { ok: false, committed: false, errors: [`'${candidate.path}' changed between verification and staging`] };
    }
  }
  for (const path of changedPaths) {
    const added = git(target, ['add', '--', literalPathspec(path)]);
    if (added.status !== 0) {
      return { ok: false, committed: false, errors: [`staging '${path}' failed: ${gitText(added)}`] };
    }
  }
  const stagedResult = git(target, ['diff', '--cached', '--name-only']);
  if (stagedResult.status !== 0) {
    return { ok: false, committed: false, errors: [`the staged path set could not be read: ${gitText(stagedResult)}`] };
  }
  const staged = String(stagedResult.stdout ?? '').split(/\r?\n/).filter(Boolean).sort();
  if (canonicalJson(staged) !== canonicalJson([...changedPaths].sort())) {
    return {
      ok: false,
      committed: false,
      errors: [`the staged path set ${JSON.stringify(staged)} does not equal the planned path set ${JSON.stringify(changedPaths)}`],
    };
  }
  // The authoritative tree: the exact staged state, captured before the commit
  // so no later index mutation can redefine what "the validated tree" means.
  const expectedTree = gitOut(target, ['write-tree']);
  if (!/^[0-9a-f]{40,64}$/.test(expectedTree ?? '')) {
    return { ok: false, committed: false, errors: ['the exact commit tree could not be captured from the verified index'] };
  }
  // Ownership binding: the full symbolic ref this transaction commits to, and
  // its exact OID, captured before `git commit` is invoked. Every judgment
  // after the hooks compares THIS ref - never ambient HEAD, which a hook may
  // have switched to another branch.
  const originalRef = gitOut(target, ['symbolic-ref', '--quiet', 'HEAD']);
  if (!originalRef || !originalRef.startsWith('refs/')) {
    return { ok: false, committed: false, errors: ['HEAD is not on a named branch; the readiness commit requires the reviewed branch'] };
  }
  const refBefore = gitOut(target, ['rev-parse', '--verify', originalRef]);
  if (refBefore !== head) {
    return { ok: false, committed: false, errors: [`the reviewed ref ${originalRef} points at ${String(refBefore)} rather than the expected HEAD ${head}`] };
  }
  const committed = git(target, ['commit', '-m', executable.finalCommitMessage]);
  // Every hook (pre-commit through post-commit) has now run. Read the reviewed
  // ref and the ambient world separately; neither is trusted alone.
  const refAfter = gitOut(target, ['rev-parse', '--verify', originalRef]);
  const ambientSymbolic = gitOut(target, ['symbolic-ref', '--quiet', 'HEAD']);
  const ambientHead = gitOut(target, ['rev-parse', 'HEAD']);
  const refMoved = refAfter !== null && refAfter !== refBefore;
  if (committed.status !== 0) {
    if (refMoved) {
      // The commit command failed, but something still advanced the reviewed
      // ref: a hook committed on it despite the refusal. Preserve everything.
      return {
        ok: false,
        committed: true,
        originalRef,
        head: refAfter,
        observedCommitCount: countCommitsAboveRef(target, originalRef, head),
        errors: [`git commit failed but the reviewed ref ${originalRef} advanced to ${refAfter}; every commit on it was preserved`],
        recovery: 'The commit command failed, but the reviewed ref moved - a hook or concurrent writer committed on it. Nothing was reset or rewritten; inspect the ref before any further mutation.',
      };
    }
    if (ambientSymbolic !== originalRef || ambientHead !== head) {
      // Refused AND the ambient world moved: restoration here could act on the
      // wrong branch, so nothing is rolled back at all.
      return {
        ok: false,
        committed: false,
        worldDiverged: true,
        originalRef,
        errors: [
          'git commit failed and a hook moved HEAD away from the reviewed branch; nothing was rolled back and all state was preserved',
          `HEAD is now ${ambientSymbolic ?? 'detached'} at ${String(ambientHead)}`,
        ],
      };
    }
    return { ok: false, committed: false, originalRef, errors: [`the readiness commit failed: ${gitText(committed)}`] };
  }
  if (!refMoved) {
    // The commit did not land on the reviewed ref. Either nothing was created,
    // or a pre-commit hook switched branches and the commit landed elsewhere:
    // both are preserved and handed to the operator.
    if (ambientHead !== null && ambientHead !== head) {
      return {
        ok: false,
        committed: true,
        originalRef,
        head: ambientHead,
        observedCommitCount: null,
        errors: [`the commit did not land on the reviewed ref ${originalRef}; HEAD is now ${ambientSymbolic ?? 'detached'} at ${ambientHead}, and every ref was preserved`],
        recovery: 'A hook redirected the commit away from the reviewed branch. Nothing was reset or rewritten; inspect where the commit landed before any further mutation.',
      };
    }
    return { ok: false, committed: false, originalRef, errors: ['git reported success but the reviewed ref did not advance; no readiness commit exists on it'] };
  }
  // Exactly ONE commit directly above the expected HEAD on the reviewed ref
  // may be this transaction's. Count and ancestry are checked BEFORE any tree
  // or message classification: anything else on the ref is not ours alone and
  // is never rewritten - including commits a post-commit hook added.
  const commitsAbove = countCommitsAboveRef(target, originalRef, head);
  if (commitsAbove !== 1) {
    return {
      ok: false,
      committed: true,
      originalRef,
      head: refAfter,
      observedCommitCount: commitsAbove,
      errors: [`${originalRef} holds ${String(commitsAbove)} commit(s) above the expected HEAD; only one direct readiness commit is this transaction's, and none were rewritten`],
      recovery: 'Additional commits exist on the reviewed ref. Every commit was preserved; resolve the sequence manually, then regenerate the plan.',
    };
  }
  const parent = gitOut(target, ['rev-parse', `${refAfter}^`]);
  if (parent !== head) {
    return {
      ok: false,
      committed: true,
      originalRef,
      head: refAfter,
      observedCommitCount: 1,
      errors: [`the commit at ${originalRef} is not a direct child of the expected HEAD ${head}; it was preserved`],
      recovery: 'The reviewed ref does not hold a direct child of the expected HEAD. Nothing was rewritten; inspect the ref before any further mutation.',
    };
  }
  // Every hook capable of changing the committed content has now run, and the
  // reviewed ref holds exactly one new commit. Validate its tree, message, and
  // attribution against the plan.
  const contentErrors = [];
  const tree = gitOut(target, ['rev-parse', `${refAfter}^{tree}`]);
  if (tree !== expectedTree) {
    const injected = git(target, ['diff-tree', '--no-commit-id', '--name-only', '-r', refAfter]);
    const changed = injected.status === 0
      ? String(injected.stdout ?? '').split(/\r?\n/).filter(Boolean).sort()
      : [];
    const unplanned = changed.filter(path => !changedPaths.includes(path));
    contentErrors.push(
      'the created readiness commit does not carry the exact validated tree; a hook or concurrent index mutation changed the commit content',
      ...(unplanned.length > 0
        ? [`unplanned path(s) entered the commit tree: ${unplanned.join(', ')}`]
        : ['the staged bytes of a planned path were changed before the commit']),
    );
  }
  const message = gitOut(target, ['show', '-s', '--format=%B', refAfter]);
  if (message !== executable.finalCommitMessage) {
    // A commit-msg hook rewrote the reviewed message.
    contentErrors.push('the readiness commit message does not equal the reviewed final commit message');
  }
  const attribution = evaluateCommitAttribution({ message, taskId: plan.taskId, role: 'maintainer' });
  if (!attribution.ok) {
    contentErrors.push(...attribution.errors.map(error => `readiness commit attribution: ${error}`));
  }
  if (contentErrors.length > 0) {
    // Contaminated: a direct child of the expected HEAD created by this commit
    // call, but not the reviewed content. Rolling it back is permitted only
    // while the world still shows exactly it: the reviewed ref at the created
    // commit AND ambient HEAD still on that ref. Any divergence - a hook that
    // switched branches or moved the ref - preserves everything instead.
    const rollbackable = ambientSymbolic === originalRef && ambientHead === refAfter;
    return { ok: false, contaminated: true, rollbackable, committed: true, originalRef, head: refAfter, errors: contentErrors };
  }
  if (ambientSymbolic !== originalRef || ambientHead !== refAfter) {
    // The commit is valid, but a hook moved HEAD elsewhere: preserve all refs.
    return {
      ok: false,
      committed: true,
      originalRef,
      head: refAfter,
      observedCommitCount: 1,
      errors: [`the readiness commit ${refAfter} is valid on ${originalRef}, but HEAD is now ${ambientSymbolic ?? 'detached'} at ${String(ambientHead)}; every ref was preserved`],
      recovery: 'A hook moved HEAD away from the reviewed branch after a valid readiness commit. Nothing was reset or rewritten; inspect both branches before any further mutation.',
    };
  }
  return { ok: true, committed: true, originalRef, head: refAfter, commit: readinessCommitFacts(target, refAfter, originalRef), errors: [] };
}

/**
 * Narrowly undo this transaction's own just-created commit on the reviewed ref.
 *
 * Called only when the created commit is a proven direct child of the expected
 * HEAD on the reviewed ref but failed exact-content validation in
 * `createReadinessCommit`, and only while the world still shows exactly that
 * commit. The rollback is bounded and non-destructive:
 *
 * - ownership is re-proved immediately before the ref moves: the reviewed ref
 *   must still point at the created commit and ambient HEAD must still be that
 *   commit on that ref - otherwise every ref and commit is preserved;
 * - the ref itself is restored by a compare-and-swap
 *   (`git update-ref <ref> <expected> <created>`), so the pointer moves back
 *   only if it still holds the created commit; a concurrent writer that moved
 *   it wins and its commits are preserved;
 * - index entries are restored one literal pathspec at a time, for exactly the
 *   paths the commit changed, to their expected-HEAD state (anchored to that
 *   commit explicitly, never to ambient HEAD);
 * - the operation-owned worktree paths are restored to their exact predecessor
 *   bytes through the mutation kernel, as in every other rollback;
 * - nothing outside the commit's own path set is touched: no `--hard`, no
 *   repository-wide reset, no discarded worktree content. A hook's worktree
 *   side effects (a file it created, for example) are left exactly as the hook
 *   left them and reported to the operator.
 */
function rollbackCreatedCommit({ target, originalRef, expectedHead, createdHead, candidates, changedPaths, beforeRefRestore = null }) {
  const errors = [];
  const ambientSymbolic = gitOut(target, ['symbolic-ref', '--quiet', 'HEAD']);
  const ambientHead = gitOut(target, ['rev-parse', 'HEAD']);
  const refNow = gitOut(target, ['rev-parse', '--verify', originalRef]);
  if (refNow !== createdHead || ambientSymbolic !== originalRef || ambientHead !== createdHead) {
    return {
      errors: [`rollback refused: ${originalRef} points at ${String(refNow)} and HEAD is ${ambientSymbolic ?? 'detached'} at ${String(ambientHead)}, not the created commit ${createdHead}; every ref and commit was preserved and must be recovered manually`],
      unplannedPaths: [],
    };
  }
  const diff = git(target, ['diff-tree', '--no-commit-id', '--name-only', '-r', createdHead]);
  if (diff.status !== 0) {
    return {
      errors: [`the created commit's changed paths could not be read: ${gitText(diff)}`],
      unplannedPaths: [],
    };
  }
  const commitPaths = String(diff.stdout ?? '').split(/\r?\n/).filter(Boolean);
  const unplannedPaths = commitPaths.filter(path => !changedPaths.includes(path));
  // Testable boundary between the ownership proof and the compare-and-swap: a
  // racing writer moving the ref here must make the swap refuse, not win.
  try {
    beforeRefRestore?.();
  } catch (error) {
    return {
      errors: [`the rollback was interrupted before the ref was restored: ${error instanceof Error ? error.message : String(error)}`],
      unplannedPaths,
    };
  }
  // Compare-and-swap ref restoration: the reviewed ref moves back to the
  // expected HEAD only if it still points at the created commit.
  const swapped = git(target, ['update-ref', originalRef, expectedHead, createdHead]);
  if (swapped.status !== 0) {
    return {
      errors: [`the compare-and-swap restoration of ${originalRef} refused: ${gitText(swapped)}; every ref and commit was preserved`],
      unplannedPaths,
    };
  }
  for (const path of commitPaths) {
    const restored = git(target, ['reset', '--quiet', expectedHead, '--', literalPathspec(path)]);
    if (restored.status !== 0) {
      errors.push(`index entry for '${path}' could not be restored: ${gitText(restored)}`);
    }
  }
  errors.push(...restorePredecessors(target, candidates, changedPaths, expectedHead));
  // Proof of restoration from the actual post-state: the reviewed ref, the
  // commit count above the expected HEAD on it, and the staged set.
  const refFinal = gitOut(target, ['rev-parse', '--verify', originalRef]);
  if (refFinal !== expectedHead) {
    errors.push(`the reviewed ref ${originalRef} points at ${String(refFinal)} after rollback, not the expected HEAD ${expectedHead}`);
  }
  const remaining = countCommitsAboveRef(target, originalRef, expectedHead);
  if (remaining === null || remaining !== 0) {
    errors.push(`the reviewed ref still holds ${String(remaining)} commit(s) above the expected HEAD after rollback`);
  }
  const staged = git(target, ['diff', '--cached', '--name-only']);
  if (staged.status !== 0) {
    errors.push(`the index could not be inspected after rollback: ${gitText(staged)}`);
  } else if (String(staged.stdout ?? '').trim() !== '') {
    errors.push(`the index still holds staged entries after rollback: ${String(staged.stdout ?? '').trim()}`);
  }
  return { errors, unplannedPaths };
}

/** Actual commit count on one ref above a base commit, or null if unreadable. */
function countCommitsAboveRef(target, ref, base) {
  const count = gitOut(target, ['rev-list', '--count', `${base}..${ref}`]);
  if (count === null) return null;
  const parsed = Number(count);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readinessCommitFacts(target, sha, ref = null) {
  return Object.freeze({
    sha,
    ref,
    parent: gitOut(target, ['rev-parse', `${sha}^`]),
    subject: gitOut(target, ['show', '-s', '--format=%s', sha]),
    author: gitOut(target, ['show', '-s', '--format=%an <%ae>', sha]),
    branch: gitOut(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  });
}

/**
 * Re-read the committed state and run the ordinary production gates over it.
 *
 * Nothing here trusts a candidate: every fact comes from actual HEAD. If any
 * gate refuses, apply reports `unresolved` rather than claiming readiness.
 */
function verifyCommittedReadiness({ target, taskId, projectConfig, plan, base, dependencies, enumerateInventory, io, activationBefore }) {
  const errors = [];
  const executable = plan.executable;
  const after = buildReadinessPlan(target, taskId, {
    projectConfig,
    actor: executable.actor,
    authority: executable.authority,
    workUnitId: executable.workUnit.id,
    base,
    dependencies,
    dependencyRef: executable.dependencies.sourceRef,
    inventory: enumerateInventory(),
    freshnessMaxAgeSeconds: executable.decomposition.freshnessMaxAgeSeconds,
    rescanTrigger: executable.decomposition.rescanTrigger,
    route: executable.decomposition.route,
  });
  if (!after.ready) errors.push(`readiness is still pending after the commit: ${after.pendingSteps.join(', ')}`);
  if (after.executable.task.status !== 'agent-ready') {
    errors.push(`the committed lifecycle status is '${String(after.executable.task.status)}', not agent-ready`);
  }
  if (after.executable.contractChain.state !== 'current') {
    errors.push(`the committed trusted contract chain is '${after.executable.contractChain.state}', not current`);
  }

  for (const [label, path] of [
    ['decomposition', executable.decomposition.path],
    ['dependency snapshot', executable.dependencies.sourceRef],
  ]) {
    const verified = verifyCommittedAttributedSource(target, path, { taskId });
    if (!verified.ok) errors.push(`the committed ${label} is not exact Maintainer-attributed evidence: ${verified.error}`);
  }

  const activationAfter = readTaskActivationBinding(target, 'files', taskId).state;
  if (activationAfter !== activationBefore) {
    errors.push(`the activation binding state changed from '${activationBefore}' to '${activationAfter}'; readiness never activates`);
  }

  const clean = git(target, ['status', '--porcelain', '--untracked-files=all']);
  if (clean.status !== 0) {
    errors.push(`the resulting repository state could not be inspected: ${gitText(clean)}`);
  } else {
    // The same staged-versus-unstaged distinction as repository safety: a
    // staged entry - even force-staged scratch under `.agenticloop/tmp/` - is
    // dirty; only untracked or unstaged transient scratch is ignored.
    const dirty = String(clean.stdout ?? '').split(/\r?\n/).filter(Boolean)
      .filter(line => {
        const { path, staged } = parsePorcelainEntry(line);
        return staged || !path.startsWith('.agenticloop/tmp/');
      });
    if (dirty.length > 0) {
      errors.push(`the tracked worktree and index are not clean after the readiness commit: ${dirty.join('; ')}`);
    }
  }

  let preflight = null;
  const silent = io ?? { out() {}, err() {}, warn() {} };
  try {
    const evaluated = evaluateHandoffPreflight({ target, taskId, backend: 'files', projectConfig, io: silent });
    const blockerCodes = [...new Set((evaluated.diagnostics ?? [])
      .filter(item => item.level === 'error')
      .map(item => String(item.code ?? 'unknown')))].sort();
    const readinessOwned = blockerCodes.filter(code =>
      READINESS_OWNED_PREFLIGHT_CODE_PREFIXES.some(prefix => code.startsWith(prefix)));
    preflight = { evaluated: true, ok: evaluated.ok === true, blockerCodes, readinessOwnedBlockers: readinessOwned };
    if (readinessOwned.length > 0) {
      errors.push(`the canonical preflight still reports readiness-owned blockers: ${readinessOwned.join(', ')}`);
    }
  } catch (error) {
    preflight = { evaluated: false, ok: false, blockerCodes: [], readinessOwnedBlockers: [] };
    errors.push(`the canonical preflight could not be evaluated after the commit: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    readiness: Object.freeze({ ...readinessSummary(after), preflight }),
  };
}
