/**
 * Read-only task explanation projection.
 *
 * This bootstrap reads canonical lifecycle, authorization, check, candidate,
 * review, and audit facts. It never evaluates a transition, creates a receipt,
 * or grants authority. The private contract document records source intent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycleOrientationSnapshot } from './lifecycle-orientation.js';
import { parseFrontmatter } from './frontmatter.js';
import { sectionBody } from './validate-config.js';
import { parseRequiredCheckInventory, validateRequiredCheckEvidence } from './required-checks.js';
import { parseFilesReviewHistory } from './review-history.js';
import { loadProjectMap } from './project-map.js';
import { taskRecordRelativePath } from './terminal-scope.js';
import { REFUSAL_CLASSES } from './refusal-classes.js';
import { evaluateHandoffPreflight } from './handoff-preflight.js';
import { dispatchDimensionDiagnosticCode } from './dispatch-eligibility.js';
import {
  evaluateProductHeadEvidence,
  implementationArtifactHead,
  targetGitRunner,
  validatePreparedCommandCheckExecutions,
} from './task-cli.js';

export const TASK_EXPLAIN_ACTION_IDS = Object.freeze([
  'prepare_dispatch', 'role_start', 'prepare_return', 'review', 'audit',
]);

/**
 * Material lifecycle facts for each protected command represented by explain.
 *
 * Keep this table aligned with the command readers, rather than hand-picking
 * facts in actionProjection: prepare-dispatch creates a packet; role-start
 * authenticates one; prepare-return and review-entry revalidate the consumed
 * packet/return lineage and its check evidence; audit gate consumes an exact
 * candidate and current audit certificate.  The contract document explains
 * deliberately excluded dimensions for each action.
 */
export const TASK_EXPLAIN_ACTION_DEPENDENCIES = Object.freeze({
  prepare_dispatch: Object.freeze([
    'dispatch.task_identity',
    'dispatch.lifecycle',
    'dispatch.task_contract',
    'dispatch.contract_baseline',
    'dispatch.required_checks',
    'dispatch.activation',
    'dispatch.activation_assurance',
    'dispatch.readiness',
    'dispatch.dependency_evidence',
    'dispatch.decomposition',
    'dispatch.work_unit_membership',
    'dispatch.maintainer_attribution',
    'dispatch.task_eligibility',
    'dispatch.repository_identity',
    'dispatch.base_identity',
    'dispatch.clean_state',
    'dispatch.assignment',
    'dispatch.host_role_capability',
    'dispatch.return_capability',
  ]),
  role_start: Object.freeze([
    'task.lifecycle.status', 'task.contract.current', 'activation.current', 'dependencies.satisfied',
    'dispatch_packet.current',
  ]),
  prepare_return: Object.freeze([
    'task.lifecycle.status', 'task.contract.current', 'activation.current', 'dispatch_packet.current',
    'required_checks.current', 'candidate.current',
  ]),
  review: Object.freeze([
    'task.lifecycle.status', 'task.contract.current', 'activation.current', 'dispatch_packet.current',
    'required_checks.current', 'candidate.current',
  ]),
  audit: Object.freeze([
    'task.lifecycle.status', 'candidate.current', 'audit.current',
  ]),
});

const OWNER_BY_FACT = Object.freeze({
  'task.lifecycle.status': REFUSAL_CLASSES['task.lifecycle.not_dispatchable'].factOwner,
  'task.contract.current': REFUSAL_CLASSES['contract.baseline.invalid'].factOwner,
  'activation.current': REFUSAL_CLASSES['activation.grant.unauthenticated'].factOwner,
  'dependencies.satisfied': REFUSAL_CLASSES['dependency.unresolved'].factOwner,
  'dispatch_packet.current': REFUSAL_CLASSES['dispatch.packet.invalid'].factOwner,
  'required_checks.current': REFUSAL_CLASSES['evidence.negative'].factOwner,
  'candidate.current': REFUSAL_CLASSES['return.lane.implementation_absent'].factOwner,
  'review.current': REFUSAL_CLASSES['review_prepare.packet'].factOwner,
  'audit.current': REFUSAL_CLASSES['audit.already_exists'].factOwner,
  'dispatch.clean_state': REFUSAL_CLASSES['worktree.clean_gate.failed'].factOwner,
  'dispatch.host_role_capability': REFUSAL_CLASSES['capability.declaration.invalid'].factOwner,
  'dispatch.return_capability': REFUSAL_CLASSES['return.assurance.insufficient'].factOwner,
});

const DISPATCH_FACT_CODES = Object.freeze({
  'dispatch.task_identity': Object.freeze(['task.record.identity_mismatch', 'task.contract.absent', 'task.contract.malformed']),
  'dispatch.lifecycle': Object.freeze(['task.lifecycle.not_dispatchable']),
  'dispatch.task_contract': Object.freeze(['task.contract.', 'scope.', 'generated.path.']),
  'dispatch.contract_baseline': Object.freeze(['contract.baseline.']),
  'dispatch.required_checks': Object.freeze(['task.contract.', 'required_check.']),
  'dispatch.activation': Object.freeze(['activation.capture.', 'activation.grant.', 'activation.binding.', 'activation.identity.', 'activation.policy.']),
  'dispatch.activation_assurance': Object.freeze(['activation.assurance.insufficient']),
  'dispatch.readiness': Object.freeze(['readiness.', 'scope.', 'generated.path.', 'task.contract.']),
  'dispatch.dependency_evidence': Object.freeze(['dependency.']),
  'dispatch.decomposition': Object.freeze(['parallel_scan.']),
  'dispatch.work_unit_membership': Object.freeze(['parallel_scan.']),
  'dispatch.maintainer_attribution': Object.freeze(['parallel_scan.']),
  'dispatch.task_eligibility': Object.freeze(['parallel_scan.']),
  'dispatch.repository_identity': Object.freeze(['dispatch.packet.invalid']),
  'dispatch.base_identity': Object.freeze(['dispatch.packet.invalid', 'readiness.base_inventory.missing']),
  'dispatch.clean_state': Object.freeze(['worktree.clean_gate.failed']),
  // Explain has no --host/--role/invocation arguments, so it cannot construct
  // the assignment that packet preparation binds and evaluates.
  'dispatch.assignment': Object.freeze(),
  'dispatch.host_role_capability': Object.freeze(['capability.declaration.invalid']),
  'dispatch.return_capability': Object.freeze(['return.assurance.insufficient']),
});

const DISPATCH_FACT_CONDITIONS = Object.freeze({
  'dispatch.task_identity': 'the requested task identity matches its current carrier',
  'dispatch.lifecycle': 'the task is dispatchable',
  'dispatch.task_contract': 'the protected task contract is current and valid',
  'dispatch.contract_baseline': 'the trusted contract baseline is current and valid',
  'dispatch.required_checks': 'the protected required-check inventory is valid',
  'dispatch.activation': 'current activation authority is authenticated',
  'dispatch.activation_assurance': 'activation assurance meets the effective policy',
  'dispatch.readiness': 'current readiness evidence is valid',
  'dispatch.dependency_evidence': 'current dependency evidence is satisfied',
  'dispatch.decomposition': 'current decomposition evidence is valid',
  'dispatch.work_unit_membership': 'the task remains a current work-unit member',
  'dispatch.maintainer_attribution': 'decomposition has current Maintainer attribution',
  'dispatch.task_eligibility': 'the decomposition declares this task eligible',
  'dispatch.repository_identity': 'the current repository identity is valid',
  'dispatch.base_identity': 'the repository base matches current readiness evidence',
  'dispatch.clean_state': 'the relevant worktree state is clean',
  'dispatch.assignment': 'a current authorized Engineer assignment is supplied',
  'dispatch.host_role_capability': 'the selected host declares the required Engineer capability',
  'dispatch.return_capability': 'the selected return capability meets the effective policy',
});

function string(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }

/** Map lifecycle orientation's closed authorization state to its governing fact. */
export function authorizationPolicyCode(state, errors = []) {
  const messages = (Array.isArray(errors) ? errors : []).map(error => String(error?.message ?? error)).join('\n');
  if (state === 'revoked') return 'activation.grant.revoked';
  if (state === 'expired') return 'activation.grant.expired';
  if (state === 'stale') return 'activation.binding.stale_contract';
  if (state === 'mismatched') {
    if (messages.includes('activation grant was issued for a different target repository')) return 'activation.grant.repository_mismatch';
    if (messages.includes('task activation binding was issued for a different target repository')) return 'activation.binding.repository_mismatch';
    return 'activation.binding.mismatch';
  }
  if (state === 'malformed') {
    return messages.includes('task activation binding') ? 'activation.binding.malformed' : 'activation.grant.malformed';
  }
  if (state === 'unauthenticated') {
    if (messages.includes('activation assurance')) return 'activation.assurance.insufficient';
    if (messages.includes('task activation binding')) return 'activation.binding.unauthenticated';
    return 'activation.grant.unauthenticated';
  }
  return 'activation.grant.unauthenticated';
}

function explanationFact(policyCode, fact, state, detail = null) {
  const classification = policyCode ? REFUSAL_CLASSES[policyCode] : null;
  return {
    policyCode: policyCode ?? null,
    fact,
    factOwner: classification?.factOwner ?? OWNER_BY_FACT[fact] ?? 'unavailable',
    state,
    ...(detail ? { detail } : {}),
  };
}
function prerequisite(fact, condition) { return { fact, condition }; }
function verdict(reasons) {
  if (reasons.some(item => item.state === 'failed')) return 'illegal';
  if (reasons.some(item => item.state === 'unknown' || item.state === 'unavailable')) return 'unknown';
  return 'legal';
}

/** Apply the same action dependency table used by the projection to fact states. */
export function actionVerdictForFactStates(id, states) {
  const dependencies = TASK_EXPLAIN_ACTION_DEPENDENCIES[id];
  if (!dependencies) throw new Error(`Unknown task explain action '${id}'`);
  return verdict(dependencies.map(fact => ({ fact, state: states?.[fact] ?? 'unknown' })));
}
function taskCheckPath(taskId) {
  return `.agenticloop/tmp/${String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')}-checks.json`;
}

function requiredChecks(target, taskId, content) {
  const inventory = parseRequiredCheckInventory(sectionBody(content, '## Required Checks') ?? '', { allowEmpty: true, allowLegacy: true });
  if (!inventory.ok) return { state: 'invalid', checkCount: 0, outcomes: [], errors: inventory.errors };
  const relativePath = taskCheckPath(taskId);
  const path = join(target, relativePath);
  if (!existsSync(path)) {
    return { state: 'unavailable', path: relativePath, checkCount: inventory.checks.length, outcomes: [], errors: [] };
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const checked = validateRequiredCheckEvidence(value, {
      allowEmpty: inventory.checks.length === 0,
      contractVersion: 2,
    });
    if (!checked.ok) return { state: 'invalid', path: relativePath, checkCount: inventory.checks.length, outcomes: [], errors: checked.errors };
    if (checked.checks.length !== inventory.checks.length ||
        !checked.checks.every((check, index) => {
          const required = inventory.checks[index];
          return check.id === required.id && check.kind === required.kind &&
            (check.kind === 'command' ? check.command === required.command : check.instruction === required.instruction);
        })) {
      return {
        state: 'invalid', path: relativePath, checkCount: inventory.checks.length, outcomes: [],
        errors: ['required-check evidence does not match the current required-check inventory'],
      };
    }
    try {
      // This is the same authoritative execution-artifact reader used by the
      // protected check-evidence path. Explain has no authenticated packet or
      // dispatch lineage, so it can establish artifact integrity but cannot
      // establish current execution currency below.
      validatePreparedCommandCheckExecutions(target, checked.checks, inventory.checks, null);
    } catch (error) {
      return {
        state: 'invalid', path: relativePath, checkCount: inventory.checks.length, outcomes: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
    const outcomes = checked.checks.map(item => ({ id: item.id, outcome: item.outcome }));
    return {
      state: outcomes.some(item => item.outcome === 'failed') ? 'failed'
        : outcomes.some(item => item.outcome !== 'passed') ? 'incomplete' : 'current',
      // Explain has no authenticated dispatch packet or consumed-attempt
      // lineage. A manual observation therefore cannot establish currency any
      // more than a command execution artifact can: each needs that binding.
      currencyState: checked.checks.some(item => item.outcome === 'passed')
        ? 'unavailable' : 'current',
      path: relativePath, checkCount: inventory.checks.length, outcomes, errors: [],
    };
  } catch (error) {
    return { state: 'invalid', path: relativePath, checkCount: inventory.checks.length, outcomes: [], errors: [error.message] };
  }
}

function reviewAndAudit(target, frontmatter, content) {
  const implementationArtifact = string(frontmatter.implementation_artifact);
  const productHead = implementationArtifactHead(content);
  const reviewStatus = string(frontmatter.review_status);
  const review = parseFilesReviewHistory(content);
  let candidate;
  if (!implementationArtifact) candidate = { state: 'unavailable', artifact: null };
  else if (!productHead) candidate = {
    state: 'invalid', artifact: implementationArtifact,
    error: 'implementation_artifact must name a full lowercase commit or range Git identity',
  };
  else {
    const refused = evaluateProductHeadEvidence(targetGitRunner(target), productHead, frontmatter.allowed_paths);
    candidate = refused
      ? { state: 'invalid', artifact: implementationArtifact, error: refused.message }
      : { state: 'current', artifact: implementationArtifact };
  }
  return {
    candidate,
    review: {
      state: review.errors.length ? 'invalid' : reviewStatus === 'accepted' ? 'accepted' : reviewStatus === 'rejected' ? 'rejected' : 'unavailable',
      status: reviewStatus,
      eventCount: review.errors.length ? null : review.events.length,
    },
    // Audit evidence is not uniformly represented in the files task carrier.
    // Report that observation gap rather than treating its absence as failure.
    audit: { state: 'unavailable', status: null },
  };
}

function dispatchFactMatchesCode(fact, diagnostic) {
  // Preflight diagnostics are evaluator-owned records. Read their closed JSON
  // projection rather than treating this presentation surface as a diagnostic
  // producer with a new dynamic code selection.
  const serialized = JSON.stringify(diagnostic);
  return DISPATCH_FACT_CODES[fact].some(prefix => serialized.includes(`"code":"${prefix}`));
}

function dispatchFactPolicyCode(fact, diagnostic) {
  const serialized = JSON.stringify(diagnostic);
  return Object.keys(REFUSAL_CLASSES).find(policyCode =>
    DISPATCH_FACT_CODES[fact].some(prefix =>
      (policyCode === prefix || policyCode.startsWith(prefix)) &&
      serialized.includes(`"code":"${policyCode}"`)
    )
  ) ?? dispatchDimensionDiagnosticCode(fact.slice('dispatch.'.length));
}

/**
 * Reuse the read-only handoff preflight's canonical dispatch evaluator for all
 * facts it can observe. That evaluator resolves the same shared facts as live
 * packet preparation, but deliberately has no assignment to bind. Explain has
 * the same limitation: it accepts neither --host nor an invocation assignment.
 */
function dispatchAdmissionFacts(target, taskId, backend, config, io) {
  let preflight;
  try {
    preflight = evaluateHandoffPreflight({
      target, taskId, backend, projectConfig: config, io: io ?? {},
    });
  } catch (error) {
    const detail = `read-only dispatch eligibility evaluation is unavailable: ${error.message}`;
    return Object.fromEntries(Object.keys(DISPATCH_FACT_CODES).map(fact => [fact, {
      state: 'unknown', policyCode: null, detail,
    }]));
  }
  const diagnostics = Array.isArray(preflight.diagnostics) ? preflight.diagnostics : [];
  return Object.fromEntries(Object.keys(DISPATCH_FACT_CODES).map(fact => {
    if (fact === 'dispatch.assignment') return [fact, {
      state: 'unknown', policyCode: null,
      detail: 'explain has no host, role, or invocation assignment to bind',
    }];
    const diagnostic = diagnostics.find(item => dispatchFactMatchesCode(fact, item));
    if (diagnostic) return [fact, {
      state: 'failed', policyCode: dispatchFactPolicyCode(fact, diagnostic),
      detail: String(diagnostic.message ?? 'dispatch eligibility fact failed'),
    }];
    // A successful shared evaluation is positive evidence for every dimension
    // it evaluated. If another dimension failed first, retain uncertainty for
    // this one rather than inferring a pass from the absence of a diagnostic.
    return [fact, preflight.ok === true
      ? { state: 'current', policyCode: null, detail: null }
      : { state: 'unknown', policyCode: null, detail: 'not established by the incomplete read-only eligibility evaluation' }];
  }));
}

function factsForTask(target, taskId, io) {
  const orientation = lifecycleOrientationSnapshot(target, { io });
  const lifecycle = orientation.tasks.find(task => task.taskId === taskId);
  if (!lifecycle) throw new Error(`Task record not found: ${taskId}`);
  const config = loadProjectMap(target).config;
  const carrier = join(target, ...taskRecordRelativePath(config, taskId).split('/'));
  const content = readFileSync(carrier, 'utf8');
  const [frontmatter] = parseFrontmatter(content);
  const presentation = reviewAndAudit(target, frontmatter ?? {}, content);
  const dispatchAdmission = dispatchAdmissionFacts(target, taskId, orientation.backend, config, io);
  return {
    id: taskId,
    carrier: lifecycle.carrier,
    backend: orientation.backend,
    lifecycle: { status: lifecycle.status, state: lifecycle.state, reasons: lifecycle.reasons },
    contract: { state: lifecycle.baseline.state, errors: lifecycle.baseline.errors },
    activation: {
      // Lifecycle orientation owns authorization. Provenance may explain a
      // missing binding but cannot elevate it into current authorization.
      state: lifecycle.operatorAuthorization.state,
      bindingState: lifecycle.operatorAuthorization.state,
      provenanceState: lifecycle.activationProvenance.state,
      errors: lifecycle.operatorAuthorization.errors,
    },
    dependencies: lifecycle.dependencies,
    dispatchAdmission,
    requiredChecks: requiredChecks(target, taskId, content),
    ...presentation,
  };
}

/** Project authorization exactly as dispatch does, preserving unknown evidence. */
function authorizationReason(facts) {
  const state = string(facts.activation?.state);
  if (state === 'present') return null;
  if (state === null || state === 'unknown' || state === 'unavailable') {
    return explanationFact(null, 'activation.current', 'unknown', 'current authorization is not observable');
  }
  return explanationFact(
    authorizationPolicyCode(state, facts.activation?.errors),
    'activation.current',
    'failed',
    `binding=${facts.activation?.bindingState ?? 'unknown'}; provenance=${facts.activation?.provenanceState ?? 'unknown'}`,
  );
}

function packetAttemptCurrencyReason() {
  return explanationFact(
    null,
    'dispatch_packet.current',
    'unknown',
    'a current authenticated dispatch packet and consumed attempt binding are not observed by this projection',
  );
}

const LIFECYCLE_STATUS_BY_ACTION = Object.freeze({
  prepare_dispatch: Object.freeze(['agent-ready']),
  role_start: Object.freeze(['agent-ready']),
  prepare_return: Object.freeze(['in-progress']),
  review: Object.freeze(['in-progress', 'review-ready']),
  audit: Object.freeze(['accepted', 'closed']),
});

// Dispatch and role start are refused outside their entry status. Later
// lifecycle transitions instead report not_applicable until their phase begins.
const NOT_APPLICABLE_OUTSIDE_LIFECYCLE = new Set(['prepare_return', 'review', 'audit']);

function dependencyReason(facts) {
  if (!Array.isArray(facts.dependencies)) {
    return explanationFact(null, 'dependencies.satisfied', 'unknown', 'declared dependency state is not observable');
  }
  const unresolved = facts.dependencies.find(dependency => dependency.disposition !== 'satisfied');
  return unresolved
    ? explanationFact('dependency.unresolved', 'dependencies.satisfied', 'failed', `${unresolved.id}:${unresolved.disposition}`)
    : null;
}

function requiredChecksReason(facts) {
  if (facts.requiredChecks.state === 'failed') return explanationFact('evidence.negative', 'required_checks.current', 'failed', 'one or more required checks failed');
  if (facts.requiredChecks.state === 'invalid') return explanationFact('evidence.malformed', 'required_checks.current', 'failed', 'required-check evidence is malformed');
  if (facts.requiredChecks.state !== 'current') return explanationFact(null, 'required_checks.current', 'unknown', facts.requiredChecks.state);
  if (facts.requiredChecks.currencyState !== 'current') {
    return explanationFact(null, 'required_checks.current', 'unknown', 'authenticated packet and attempt binding is unobservable by explain');
  }
  return null;
}

function candidateReason(facts) {
  if (facts.candidate.state === 'invalid') return explanationFact('task.evidence.product_head', 'candidate.current', 'failed', facts.candidate.error);
  if (facts.candidate.state !== 'current') return explanationFact(null, 'candidate.current', 'unknown', facts.candidate.state);
  return null;
}

function auditReason(facts) {
  if (facts.audit.state === 'invalid') return explanationFact(null, 'audit.current', 'failed', facts.audit.error ?? 'audit evidence is invalid');
  if (facts.audit.state !== 'current') return explanationFact(null, 'audit.current', 'unknown', facts.audit.state ?? 'unavailable');
  return null;
}

function actionFactReason(id, fact, facts) {
  if (fact.startsWith('dispatch.')) {
    const observed = facts.dispatchAdmission?.[fact];
    if (observed?.state === 'current') return null;
    return explanationFact(
      observed?.policyCode ?? null,
      fact,
      observed?.state === 'failed' ? 'failed' : 'unknown',
      observed?.detail ?? 'dispatch eligibility fact is not observable',
    );
  }
  if (fact === 'task.lifecycle.status') {
    const applicable = LIFECYCLE_STATUS_BY_ACTION[id];
    return applicable.includes(facts.lifecycle.status)
      ? null
      : explanationFact('task.lifecycle.not_dispatchable', fact, 'failed', facts.lifecycle.status ?? 'missing');
  }
  if (fact === 'task.contract.current') {
    return facts.contract.state === 'current'
      ? null
      : explanationFact('contract.baseline.invalid', fact, 'failed', facts.contract.state);
  }
  if (fact === 'activation.current') return authorizationReason(facts);
  if (fact === 'dependencies.satisfied') return dependencyReason(facts);
  if (fact === 'dispatch_packet.current') return packetAttemptCurrencyReason();
  if (fact === 'required_checks.current') return requiredChecksReason(facts);
  if (fact === 'candidate.current') return candidateReason(facts);
  if (fact === 'audit.current') return auditReason(facts);
  throw new Error(`Unknown task explain fact '${fact}' for action '${id}'`);
}

function actionPrerequisites(reasons) {
  return reasons.map(item => prerequisite(item.fact,
    DISPATCH_FACT_CONDITIONS[item.fact] ??
    (item.fact === 'task.lifecycle.status' ? 'the action lifecycle status applies'
      : item.fact === 'task.contract.current' ? 'contract baseline is current'
        : item.fact === 'activation.current' ? 'operator authorization is present'
          : item.fact === 'dependencies.satisfied' ? 'every declared dependency is satisfied'
            : item.fact === 'dispatch_packet.current' ? 'a current authenticated dispatch packet binds the consumed attempt'
              : item.fact === 'required_checks.current' ? 'every required check has current passed evidence bound to the consumed attempt'
                : item.fact === 'candidate.current' ? 'a current implementation candidate is declared'
                  : 'current independent audit state is available')
  ));
}

function actionProjection(id, facts) {
  const applicable = LIFECYCLE_STATUS_BY_ACTION[id];
  if (!applicable.includes(facts.lifecycle.status) && NOT_APPLICABLE_OUTSIDE_LIFECYCLE.has(id)) {
    return {
      id,
      verdict: 'not_applicable',
      reasons: [],
      prerequisites: [prerequisite('task.lifecycle.status', `status is ${applicable.join(' or ')}`)],
    };
  }
  const dependencies = TASK_EXPLAIN_ACTION_DEPENDENCIES[id];
  const reasons = dependencies
    .map(fact => actionFactReason(id, fact, facts))
    .filter(Boolean);
  // Use the table-driven reducer rather than a hand-picked reason list: a
  // newly material fact cannot be silently omitted from a legal verdict.
  const states = Object.fromEntries(dependencies.map(fact => [fact, 'current']));
  for (const reason of reasons) states[reason.fact] = reason.state;
  return { id, verdict: actionVerdictForFactStates(id, states), reasons, prerequisites: actionPrerequisites(reasons) };
}

/** Build a bounded explanation from existing canonical facts; this has no writer. */
export function explainTask(target, taskId, { action = null, io = null } = {}) {
  if (action !== null && !TASK_EXPLAIN_ACTION_IDS.includes(action)) {
    throw new Error(`Unknown task explain action '${action}'; expected one of: ${TASK_EXPLAIN_ACTION_IDS.join(', ')}`);
  }
  const task = factsForTask(target, taskId, io);
  return Object.freeze({
    derived: true,
    persisted: false,
    authority: 'none',
    task,
    actions: (action ? [action] : TASK_EXPLAIN_ACTION_IDS).map(id => actionProjection(id, task)),
  });
}

/** Human output is a direct rendering of the JSON facts, never separate state. */
export function renderTaskExplanation(explanation) {
  const { task } = explanation;
  const lines = [
    // This compact canonical fact line is the parity anchor: human output and
    // JSON carry precisely the same task facts without a second presentation
    // model. The following lines remain scannable for an operator.
    `facts: ${JSON.stringify(task)}`,
    `task: ${task.id}`,
    `carrier: ${task.carrier}`,
    `backend: ${task.backend}`,
    `lifecycle.status: ${task.lifecycle.status ?? 'unknown'}`,
    `lifecycle.state: ${task.lifecycle.state}`,
    `contract.state: ${task.contract.state}`,
    `activation.state: ${task.activation.state}`,
    `required_checks.state: ${task.requiredChecks.state}`,
    `candidate.state: ${task.candidate.state}`,
    `review.state: ${task.review.state}`,
    `audit.state: ${task.audit.state}`,
  ];
  for (const action of explanation.actions) {
    lines.push(`action: ${action.id}`);
    lines.push(`  verdict: ${action.verdict}`);
    for (const item of action.reasons) lines.push(`  reason: ${item.fact}; state=${item.state}; fact_owner=${item.factOwner}; policy_code=${item.policyCode ?? 'none'}${item.detail ? `; detail=${item.detail}` : ''}`);
    for (const item of action.prerequisites) lines.push(`  prerequisite: ${item.fact}; condition=${item.condition}`);
  }
  lines.push('authority: none');
  lines.push('persisted: false');
  return lines.join('\n');
}
