/**
 * Canonical readiness candidate preparation.
 *
 * `task establish-baseline`, `task status`, and `task readiness-apply` all have
 * to build and validate the same three candidates: the trusted-contract
 * baseline record, the agent-ready evidence context, and the agent-ready task
 * carrier bytes. Before this module each one lived inline in a single command
 * body, so the only way to orchestrate them together was to re-run the commands
 * - which is exactly the multi-command, multi-commit sequence the field record
 * measured, because each command commits nothing and the next one refuses
 * uncommitted evidence.
 *
 * So the preparation is extracted here verbatim and the commands call it. There
 * is one difference between the standalone and orchestrated uses, and it is the
 * whole reason the orchestration is possible: a caller may supply
 * `prospectiveRecords`, so the agent-ready baseline check can be evaluated
 * against a baseline that is about to enter the same commit rather than one that
 * is already committed. `validateTaskContractBaseline` already supports exactly
 * that - `establish-baseline` uses it to refuse a second baseline over trusted
 * history - so no validator is weakened and no second validator is created.
 *
 * Every function here is pure with respect to the target: it reads and
 * validates, and returns candidate bytes. Nothing in this module writes.
 */

import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import { parseFrontmatter, replaceFrontmatterField } from './frontmatter.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';
import { validateTaskRecordDiagnostics } from './validate-config.js';
import { validateTaskStatusTransition } from './task-transition.js';
import { assertLifecycleHandoffResolved } from './lifecycle-plan.js';
import { evaluateTaskReadiness } from './task-readiness.js';
import { filesTaskContractHistoryPath, loadFilesTaskContractRecords } from './files-task-contract.js';
import {
  createTaskContractBaselineRecord,
  taskContractDigest,
  validateTaskContractBaseline,
} from './task-contract-baseline.js';
import { createTaskEvidenceContext } from './task-evidence-contract.js';

/** Digest of one exact task-record byte sequence. */
export function taskRecordDigest(content) {
  return `sha256:${createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')}`;
}

function frontmatterString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function failure(stage, errors, extra = {}) {
  return { ok: false, stage, errors: [...errors], ...extra };
}

/**
 * Prepare one trusted-contract baseline candidate for a files-backed task.
 *
 * The record is validated against the committed chain through the existing
 * baseline validator before it is returned, so a second baseline over trusted
 * history is refused here rather than after a write. The candidate bytes are the
 * exact append: current committed carrier content plus one JSONL line, so the
 * caller may either append (the standalone command) or write the whole candidate
 * through the mutation kernel (the orchestrated transaction).
 *
 * @param {{ target: string, taskId: string, body: string, actor: string,
 *   authority: string, timestamp: string, recordId: string,
 *   affectedArtifact: string, currentHistory?: string|null }} input
 */
export function prepareTrustedBaselineCandidate(input) {
  const { target, taskId, body, actor, authority, timestamp, recordId, affectedArtifact } = input;
  const contract = taskContractDigest(body);
  if (!contract.ok) return failure('task_contract', [contract.error]);
  const history = loadFilesTaskContractRecords(target, taskId);
  if (history.errors.length) return failure('trusted_history', history.errors, { history });

  let record;
  try {
    record = createTaskContractBaselineRecord({
      recordId,
      taskId,
      digest: contract.digest,
      projection: contract.projection,
      authority: String(authority),
      actor: String(actor),
      timestamp,
      affectedArtifact,
    });
  } catch (error) {
    return failure('baseline_record', [error instanceof Error ? error.message : String(error)], { history });
  }

  // A second baseline is never created over trusted history: the prospective
  // record is validated against the committed chain before anything is written.
  const prospective = validateTaskContractBaseline(body, {
    lifecycle: 'legacy',
    trustedRecords: history.trustedRecords,
    prospectiveRecords: [record],
  });
  if (!prospective.ok) return failure('baseline_validation', prospective.errors, { history, record });

  const relPath = relative(target, filesTaskContractHistoryPath(target, taskId)).replace(/\\/g, '/');
  const line = `${JSON.stringify(record)}\n`;
  const currentHistory = input.currentHistory ?? null;
  return {
    ok: true,
    stage: 'ok',
    errors: [],
    record,
    history,
    relPath,
    line,
    candidate: `${currentHistory ?? ''}${line}`,
    contract,
  };
}

/**
 * Evaluate the exact readiness evidence a transition into `agent-ready`
 * requires.
 *
 * `prospectiveRecords` is the one orchestration seam: with it the trusted
 * contract chain may be satisfied by a baseline entering the same commit. Every
 * other input and every validator is the same one the standalone transition
 * uses.
 *
 * @param {{ target: string, taskId: string, relPath: string, currentContent: string,
 *   parsedContent: string, currentDigest: string, currentStatus: string,
 *   base: object, dependencies: object, prospectiveRecords?: Array<object>,
 *   trustedRecords?: Array<object>|null, trustedRecordErrors?: string[]|null }} input
 */
export function prepareAgentReadyEvidence(input) {
  const {
    target, taskId, relPath, currentContent, parsedContent, currentDigest, currentStatus,
    base, dependencies, prospectiveRecords = [],
  } = input;

  assertLifecycleHandoffResolved(target);

  let evidenceContext;
  try {
    evidenceContext = createTaskEvidenceContext({
      backend: 'files',
      task: { id: taskId, carrier: relPath, expectedDigest: currentDigest },
      transition: { fromStatus: currentStatus, toStatus: 'agent-ready' },
      base: base.evidence,
      dependencies: dependencies.evidence,
    });
  } catch (error) {
    return failure('evidence_context', [error instanceof Error ? error.message : String(error)]);
  }

  const readiness = evaluateTaskReadiness({
    taskBody: parsedContent,
    basePaths: base.paths,
    mode: 'authoring',
    dependencies: dependencies.statuses,
  });
  if (readiness.errors.length > 0 || readiness.warnings.length > 0) {
    return failure('readiness', readiness.errors, { readiness, evidenceContext });
  }

  // Entering agent-ready is always a lifecycle transition: even a schema-less
  // legacy task requires a trusted baseline chain first.
  const history = input.trustedRecords === undefined || input.trustedRecords === null
    ? loadFilesTaskContractRecords(target, taskId)
    : { trustedRecords: input.trustedRecords, errors: input.trustedRecordErrors ?? [] };
  const baseline = validateTaskContractBaseline(currentContent, {
    lifecycle: 'transition',
    trustedRecords: history.trustedRecords,
    trustedRecordErrors: history.errors,
    prospectiveRecords,
  });
  if (!baseline.ok) return failure('baseline', baseline.errors, { readiness, evidenceContext, baseline });

  return { ok: true, stage: 'ok', errors: [], readiness, evidenceContext, baseline, history };
}

/**
 * Build and fully validate one task-carrier status candidate.
 *
 * This is the candidate construction `task status` performs: the status field is
 * replaced, `block_category` is set or cleared, an optional note is appended,
 * and the resulting bytes are validated as a complete task record before they
 * can be written.
 *
 * @param {{ currentContent: string, relPath: string, nextStatus: string,
 *   blockCategory?: string|null, note?: string|null,
 *   appendNote?: (content: string, note: string) => string }} input
 */
export function prepareTaskStatusCandidate(input) {
  const { currentContent, relPath, nextStatus, blockCategory = null, note = null, appendNote = null } = input;
  let candidate = replaceFrontmatterField(currentContent, 'status', nextStatus);
  candidate = nextStatus === 'blocked'
    ? replaceFrontmatterField(candidate, 'block_category', blockCategory)
    : replaceFrontmatterField(candidate, 'block_category', null);
  if (note && appendNote) candidate = appendNote(candidate, String(note));
  const candidateRoot = evaluateTaskRecordRoot(candidate);
  const diagnostics = candidateRoot.ok
    ? validateTaskRecordDiagnostics(candidate, relPath)
    : candidateRoot.diagnostics;
  if (diagnostics.length > 0) {
    return failure('candidate_invalid', diagnostics.map(item => item.message), {
      candidate,
      candidateDigest: taskRecordDigest(candidate),
      diagnostics,
    });
  }
  return {
    ok: true,
    stage: 'ok',
    errors: [],
    candidate,
    candidateDigest: taskRecordDigest(candidate),
    diagnostics: [],
  };
}

/**
 * Validate the current task carrier before it may authorize any transition:
 * record root, record identity, legal transition, and full record validity.
 *
 * Returned as structured stages so each caller keeps its own result envelope.
 *
 * @param {{ currentContent: string, relPath: string, taskId: string, nextStatus: string,
 *   note?: string|null }} input
 */
export function evaluateCurrentTaskCarrier(input) {
  const { currentContent, relPath, taskId, nextStatus, note = null } = input;
  const root = evaluateTaskRecordRoot(currentContent);
  if (!root.ok) return failure('record_root', root.diagnostics.map(item => item.message), { root });
  const [frontmatter] = parseFrontmatter(currentContent);
  const recordIdentity = frontmatterString(frontmatter?.task_id);
  if (recordIdentity !== taskId) {
    return failure('identity', [
      `The requested task identity '${taskId}' differs from the materialized record identity ` +
      `'${recordIdentity || '(absent)'}' in ${relPath}.`,
    ], { recordIdentity });
  }
  const currentStatus = frontmatterString(frontmatter?.status);
  const transitionError = validateTaskStatusTransition(currentStatus, nextStatus, note);
  if (transitionError) return failure('transition', [transitionError], { currentStatus });
  const diagnostics = validateTaskRecordDiagnostics(currentContent, relPath);
  if (diagnostics.length > 0) {
    return failure('current_invalid', diagnostics.map(item => item.message), { currentStatus, diagnostics });
  }
  return {
    ok: true,
    stage: 'ok',
    errors: [],
    currentStatus,
    currentDigest: taskRecordDigest(currentContent),
    diagnostics: [],
  };
}
