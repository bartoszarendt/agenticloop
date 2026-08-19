/**
 * Execution-attempt identity and packet conservation.
 *
 * A dispatch packet is not a ticket that can be reissued. It is the evidence
 * that one specific execution attempt started from one specific product base,
 * and once an Engineer has mutated anything under it, that evidence is the only
 * thing that can still explain what the mutation was relative to.
 *
 * The field record shows what happens without that rule. The field session dispatched
 * before readiness was settled, then minted fresh packets and repaired history
 * after implementation, until no retained packet represented the start of the
 * work that had actually been done. `prepare-return` then had nothing truthful
 * to bind, and the task ended `blocked` at return production. The session
 * concluded that same-checkout return was structurally impossible; it was not.
 * The lineage had been destroyed, not proven absent.
 *
 * So this module answers one question - **may a new packet be consumed for this
 * task right now?** - from durable evidence only:
 *
 * - No prior consumption: this is a first attempt. Allowed.
 * - A prior attempt exists and was explicitly abandoned: allowed, as a new
 *   attempt, with the abandoned one still on record.
 * - A prior attempt exists, is live, and the Engineer has mutated nothing yet:
 *   allowed. Nothing has been built against the old base, so nothing is lost.
 * - A prior attempt exists, is live, and the Engineer has mutated something:
 *   **refused**. The attempt reaches a canonical return or it is explicitly
 *   abandoned; it is never silently replaced.
 *
 * The last case is the invariant. It costs an operator one explicit command in
 * the rare case, and it makes "no retained packet represents this work" a state
 * the protocol cannot reach by accident.
 *
 * What this module does *not* do: it never decides that an attempt succeeded,
 * never writes anything, and never infers abandonment from silence. An
 * abandonment is an authored record or it did not happen.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { GIT_MAX_BUFFER } from './git-runner.js';

import { canonicalSha256 } from './canonical-json.js';
import { listWorkflowEvidenceFiles } from './carrier-root.js';
import { classifyLifecycleCompatibility, compatibilityMessage } from './lifecycle-compatibility.js';
import {
  listCarrierMutationReceipts,
  listDispatchConsumptions,
} from './handoff-consumption.js';

export const EXECUTION_ATTEMPT_ABANDONMENT_KIND = 'agenticloop.execution-attempt-abandonment';
export const EXECUTION_ATTEMPT_ABANDONMENT_SCHEMA_VERSION = 1;
export const EXECUTION_ATTEMPT_ROOT = '.agenticloop/handoffs/attempts';

/** The one diagnostic code a conservation refusal reports under. */
export const PACKET_CONSERVATION_DIAGNOSTIC_CODE = 'dispatch.packet.conserved';

/** The one diagnostic code a rewritten attempt range reports under. */
export const ATTEMPT_HISTORY_DIAGNOSTIC_CODE = 'dispatch.attempt.history_rewritten';

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ATTEMPT_ID_RE = /^attempt:[a-f0-9]{32}$/;

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Derive the execution-attempt identity from the consumption that started it.
 *
 * Deterministic and derived rather than minted, so the identity cannot drift
 * from the evidence it names and needs no separate store to stay truthful. It
 * binds the packet, the invocation, and the product base the attempt started
 * from: two attempts that share a packet id but not a base are not the same
 * attempt, and neither are two that share a base but not an invocation.
 */
export function executionAttemptIdentity(consumption) {
  if (!consumption?.packetId || !consumption?.invocationId || !consumption?.productBaseHead) {
    throw new TypeError('an execution attempt identity requires packetId, invocationId, and productBaseHead');
  }
  const digest = canonicalSha256({
    packetId: consumption.packetId,
    packetDigest: consumption.packetDigest,
    invocationId: consumption.invocationId,
    productBaseHead: consumption.productBaseHead,
    taskId: consumption.taskId,
  });
  return `attempt:${digest.slice(0, 32)}`;
}

/** Validate one authored abandonment record against the closed schema. */
export function validateExecutionAttemptAbandonment(record, { taskId = null, now = Date.now() } = {}) {
  const required = [
    'kind', 'schemaVersion', 'backend', 'taskId', 'attemptId', 'packetId',
    'reason', 'disposition', 'authority', 'abandonedAt',
  ];
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== required.length ||
      Object.keys(record).some(key => !required.includes(key))) {
    return { ok: false, errors: ['execution attempt abandonment fields must equal the closed schema'] };
  }
  if (record.kind !== EXECUTION_ATTEMPT_ABANDONMENT_KIND) {
    errors.push(`execution attempt abandonment kind must be '${EXECUTION_ATTEMPT_ABANDONMENT_KIND}'`);
  }
  if (record.schemaVersion !== EXECUTION_ATTEMPT_ABANDONMENT_SCHEMA_VERSION) {
    errors.push(`execution attempt abandonment schemaVersion must be ${EXECUTION_ATTEMPT_ABANDONMENT_SCHEMA_VERSION}`);
  }
  if (!['files', 'github'].includes(record.backend)) errors.push('execution attempt abandonment backend is invalid');
  if (typeof record.taskId !== 'string' || !record.taskId) errors.push('execution attempt abandonment taskId is invalid');
  if (taskId !== null && record.taskId !== taskId) {
    errors.push(`execution attempt abandonment taskId '${record.taskId}' does not match expected task '${taskId}'`);
  }
  if (!ATTEMPT_ID_RE.test(String(record.attemptId ?? ''))) errors.push('execution attempt abandonment attemptId is invalid');
  if (typeof record.packetId !== 'string' || !record.packetId) errors.push('execution attempt abandonment packetId is invalid');
  // A reason is required and cannot be empty: "abandoned" without a stated
  // cause is exactly the silent replacement this record exists to prevent.
  if (typeof record.reason !== 'string' || record.reason.trim().length < 16) {
    errors.push('execution attempt abandonment reason must state why the attempt cannot reach a canonical return');
  }
  if (!['abandoned', 'superseded_by_maintainer_repair'].includes(record.disposition)) {
    errors.push("execution attempt abandonment disposition must be 'abandoned' or 'superseded_by_maintainer_repair'");
  }
  // Abandoning a live attempt discards execution evidence, so it names the
  // durable authorization that permitted it rather than being self-authorizing.
  if (typeof record.authority !== 'string' || !/^[a-z][a-z0-9_-]*:.+$/.test(record.authority)) {
    errors.push("execution attempt abandonment authority must be a durable '<kind>:<reference>' reference");
  }
  const abandonedMs = Date.parse(record.abandonedAt);
  if (!ISO_UTC_RE.test(String(record.abandonedAt ?? '')) || !Number.isFinite(abandonedMs)) {
    errors.push('execution attempt abandonment abandonedAt must be a strict ISO-8601 UTC instant');
  } else if (abandonedMs > now + 1000) {
    errors.push('execution attempt abandonment abandonedAt is future-dated');
  }
  return { ok: errors.length === 0, errors };
}

/** The storage path for one abandonment record. */
export function executionAttemptAbandonmentRelativePath(record) {
  return `${EXECUTION_ATTEMPT_ROOT}/${safeSegment(record.taskId)}/${safeSegment(record.attemptId)}.json`;
}

/**
 * Read every authored abandonment for one task.
 *
 * Fails closed: an unreadable or invalid record is an error, never a silently
 * skipped entry. Treating "I cannot read this abandonment" as "there is no
 * abandonment" would let a corrupted record re-enable exactly the reminting
 * this module refuses.
 */
export function listExecutionAttemptAbandonments(target, taskId, options = {}) {
  const records = [];
  const errors = [];
  for (const { name, path } of listWorkflowEvidenceFiles(
    target, [...EXECUTION_ATTEMPT_ROOT.split('/'), safeSegment(taskId)]
  )) {
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      const compatibility = classifyLifecycleCompatibility(record, EXECUTION_ATTEMPT_ABANDONMENT_KIND);
      if (compatibility.state !== 'current') {
        errors.push(`${name}: ${compatibilityMessage(compatibility, 'execution attempt abandonment')}`);
        continue;
      }
      const checked = validateExecutionAttemptAbandonment(record, { taskId, ...options });
      if (!checked.ok) errors.push(...checked.errors.map(error => `${name}: ${error}`));
      else if (name !== `${safeSegment(record.attemptId)}.json`) {
        errors.push(`${name}: execution attempt abandonment filename does not match its attempt identity`);
      } else records.push(record);
    } catch (error) {
      errors.push(`${name}: execution attempt abandonment is unreadable: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, records, errors };
}

/**
 * Group durable consumption evidence into ordered execution attempts.
 *
 * One consumption starts one attempt. The attempt is `abandoned` when an
 * authored record names it, and `live` otherwise. Ordering is by `consumedAt`
 * with the packet id as a deterministic tiebreak, so two consumptions recorded
 * in the same millisecond still produce a stable sequence.
 */
export function groupExecutionAttempts({ consumptions = [], abandonments = [] } = {}) {
  const abandonedBy = new Map(abandonments.map(record => [record.attemptId, record]));
  const ordered = [...consumptions].sort((left, right) =>
    Date.parse(left.consumedAt) - Date.parse(right.consumedAt) ||
    String(left.packetId).localeCompare(String(right.packetId)));
  return ordered.map((consumption, index) => {
    const attemptId = executionAttemptIdentity(consumption);
    const abandonment = abandonedBy.get(attemptId) ?? null;
    return Object.freeze({
      attemptId,
      sequence: index + 1,
      packetId: consumption.packetId,
      packetDigest: consumption.packetDigest,
      invocationId: consumption.invocationId,
      // The product base this attempt started from. A packet minted after
      // product work names a different base, and that difference is the whole
      // reason the original packet cannot be replaced by a later one.
      productBaseHead: consumption.productBaseHead,
      consumedAt: consumption.consumedAt,
      state: abandonment ? 'abandoned' : 'live',
      abandonment,
    });
  });
}

/**
 * Decide whether a new dispatch packet may start an attempt for this task.
 *
 * `engineerMutationCount` is the number of carrier mutation receipts recorded
 * under the live attempt: the durable proof that the Engineer has already
 * changed state relative to the attempt's product base.
 *
 * @returns {{ ok: boolean, code: string|null, reason: string|null, liveAttempt: object|null, attempts: object[], repair: string|null }}
 */
export function evaluatePacketConservation({
  consumptions = [],
  abandonments = [],
  engineerMutationCount = 0,
  taskId = '<task-id>',
} = {}) {
  const attempts = groupExecutionAttempts({ consumptions, abandonments });
  const liveAttempt = attempts.filter(attempt => attempt.state === 'live').at(-1) ?? null;
  const allow = (liveAttemptValue = null) => ({
    ok: true, code: null, reason: null, liveAttempt: liveAttemptValue, attempts, repair: null,
  });

  if (!liveAttempt) return allow(null);
  if (engineerMutationCount <= 0) {
    // A live attempt that has produced nothing costs nothing to replace, and
    // refusing here would turn an ordinary retry into an operator ceremony.
    return allow(liveAttempt);
  }
  return {
    ok: false,
    code: PACKET_CONSERVATION_DIAGNOSTIC_CODE,
    reason:
      `execution attempt ${liveAttempt.attemptId} is live and has already recorded ` +
      `${engineerMutationCount} Engineer mutation(s) against product base ${liveAttempt.productBaseHead}; ` +
      'a consumed packet reaches a canonical return or is explicitly abandoned, and is never silently replaced',
    liveAttempt,
    attempts,
    repair:
      `Complete the attempt with 'npx agenticloop task prepare-return ${taskId} --packet <the retained packet.json>'. ` +
      'If its lineage genuinely cannot be preserved, abandon it explicitly with ' +
      `'npx agenticloop task abandon-attempt ${taskId} --attempt ${liveAttempt.attemptId} ` +
      "--reason <text> --authority <kind:reference>', then request a new packet.",
  };
}

/**
 * Read the durable evidence and decide, in one call.
 *
 * The read-side companion to `evaluatePacketConservation`: unreadable evidence
 * fails closed rather than being treated as an absence of attempts.
 */
export function evaluateTaskPacketConservation(target, taskId, { backend = 'files', runGit = defaultRunGit(target) } = {}) {
  const consumed = listDispatchConsumptions(target, taskId, { backend });
  if (!consumed.ok) {
    return {
      ok: false,
      code: PACKET_CONSERVATION_DIAGNOSTIC_CODE,
      reason: `dispatch consumption evidence is unreadable: ${consumed.errors.join('; ')}`,
      liveAttempt: null,
      attempts: [],
      repair: 'Repair the dispatch consumption records before requesting a new packet.',
    };
  }
  const abandoned = listExecutionAttemptAbandonments(target, taskId);
  if (!abandoned.ok) {
    return {
      ok: false,
      code: PACKET_CONSERVATION_DIAGNOSTIC_CODE,
      reason: `execution attempt abandonment evidence is unreadable: ${abandoned.errors.join('; ')}`,
      liveAttempt: null,
      attempts: [],
      repair: 'Repair the execution attempt abandonment records before requesting a new packet.',
    };
  }
  const mutations = listCarrierMutationReceipts(target, taskId, { backend });
  if (!mutations.ok) {
    return {
      ok: false,
      code: PACKET_CONSERVATION_DIAGNOSTIC_CODE,
      reason: `carrier mutation evidence is unreadable: ${mutations.errors.join('; ')}`,
      liveAttempt: null,
      attempts: [],
      repair: 'Repair the carrier mutation receipts before requesting a new packet.',
    };
  }
  const attempts = groupExecutionAttempts({ consumptions: consumed.records, abandonments: abandoned.records });
  const live = attempts.filter(attempt => attempt.state === 'live').at(-1) ?? null;
  // Receipts are scoped to the live attempt by the same immutable dispatch
  // tuple `resolveCarrierLineage` uses, not by wall clock. A receipt belongs to
  // the attempt whose invocation produced it; a clock comparison would both
  // miscount a receipt written during a slow attempt and depend on state that
  // can move without any observable repository event.
  const liveConsumption = live
    ? consumed.records.find(record => executionAttemptIdentity(record) === live.attemptId) ?? null
    : null;
  const engineerMutationCount = liveConsumption
    ? mutations.records.filter(receipt =>
      receipt?.dispatchCarrierDigest === liveConsumption.dispatchCarrierDigest &&
      receipt?.producer?.invocationId === liveConsumption.invocationId).length
    : 0;
  const verdict = evaluatePacketConservation({
    consumptions: consumed.records,
    abandonments: abandoned.records,
    engineerMutationCount,
    taskId,
  });
  // Rewritten provenance is detected here, where the ledger is read, rather
  // than discovered after the fact. The field run's Engineer reset commits, and
  // the Orchestrator's first recovery act an hour later was to check whether
  // any `git replace` refs had survived. Nothing mechanically noticed.
  const history = evaluateAttemptHistoryIntegrity(target, verdict.attempts, { runGit });
  if (history.ok) return { ...verdict, historyIntegrity: history };
  return {
    ...verdict,
    ok: false,
    code: ATTEMPT_HISTORY_DIAGNOSTIC_CODE,
    reason: history.reason,
    repair: history.repair,
    historyIntegrity: history,
  };
}

function defaultRunGit(target) {
  return args => spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
}

/**
 * Check that every recorded attempt still describes reachable, unreplaced
 * history.
 *
 * Unevaluable is not a finding: a target that is not a Git checkout, or a Git
 * that cannot be run, reports `evaluated: false` rather than manufacturing a
 * rewrite. Only a base that Git can no longer reach, a base that is no longer
 * an ancestor of the current head, or a live `git replace` mapping is reported
 * - each of those is a rewrite of the exact history an attempt is evidence
 * about.
 *
 * @param {string} target
 * @param {object[]} attempts  grouped attempts from `groupExecutionAttempts`
 * @param {{ runGit?: (args: string[]) => { status: number, stdout?: string } }} [options]
 */
export function evaluateAttemptHistoryIntegrity(target, attempts = [], { runGit = defaultRunGit(target) } = {}) {
  const unevaluated = { ok: true, evaluated: false, findings: [], reason: null, repair: null };
  if (attempts.length === 0) return unevaluated;
  let head;
  try {
    head = runGit(['rev-parse', '--verify', 'HEAD']);
  } catch {
    return unevaluated;
  }
  if (!head || head.status !== 0) return unevaluated;
  const findings = [];
  const replaced = runGit(['replace', '-l']);
  if (replaced?.status === 0 && String(replaced.stdout ?? '').trim()) {
    findings.push(
      'the repository carries live git replace refs, so the commits this attempt names are not the commits Git reports'
    );
  }
  for (const attempt of attempts) {
    const base = attempt?.productBaseHead;
    if (!base) continue;
    if (runGit(['cat-file', '-e', `${base}^{commit}`])?.status !== 0) {
      findings.push(
        `attempt ${attempt.attemptId} recorded product base ${base}, which is no longer a reachable commit object`
      );
      continue;
    }
    if (runGit(['merge-base', '--is-ancestor', base, 'HEAD'])?.status !== 0) {
      findings.push(
        `attempt ${attempt.attemptId} recorded product base ${base}, which is no longer an ancestor of the current head`
      );
    }
  }
  if (findings.length === 0) return { ok: true, evaluated: true, findings: [], reason: null, repair: null };
  return {
    ok: false,
    evaluated: true,
    findings,
    reason: `durable history in a recorded execution attempt range was rewritten or replaced: ${findings.join('; ')}`,
    repair:
      'Stop. Rewriting execution provenance is Maintainer-owned repair, never role work: restore the recorded ' +
      'history from Git (reflog, remote, or replace-ref removal), or record the rewrite explicitly with ' +
      "'npx agenticloop commit-attribution repair-record-render' and a durable human authority before any " +
      'further dispatch.',
  };
}
