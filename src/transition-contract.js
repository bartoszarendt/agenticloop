/**
 * Backend-neutral transition vocabulary shared by files and GitHub projections.
 *
 * These tables define facts and boundaries only. They do not dispatch a role,
 * mutate a carrier, or select a recovery path; those operations consume this
 * contract in their owning modules.
 */

export const TRANSITION_CONTRACT_ID = 'agenticloop.transition-contract';
export const TRANSITION_CONTRACT_SCHEMA_VERSION = 1;
export const TRANSITION_BACKENDS = Object.freeze(['files', 'github']);

export const TRANSITION_ENVELOPE_FIELDS = Object.freeze([
  'transition',
  'artifact',
  'digest',
  'provenance',
  'freshness',
  'validation',
  'disposition',
]);

/** A missing input is distinct from supplied evidence that proves a negative fact. */
export const TRANSITION_EVIDENCE_STATES = Object.freeze([
  'current',
  'missing',
  'malformed',
  'stale',
  'negative',
  'changed',
]);

export const TRANSITION_DISPOSITIONS = Object.freeze([
  'proceed',
  'blocked',
  'needs_context',
  'rejected',
  'superseded',
  'exception_requested',
  'exception_accepted',
  'exception_rejected',
]);

/** Lifecycle claims are authoritative only when their required receipt is current. */
export const TRANSITION_LIFECYCLE_CLAIMS = Object.freeze([
  'implementation_blocked',
  'implementation_ready_for_review',
  'review_changes_requested',
  'review_accepted',
  'closeout_complete',
]);

export const TRANSITION_CAPABILITY_ENFORCEMENT = Object.freeze([
  'enforced',
  'advisory',
  'unavailable',
]);

/** A non-enforced capability is useful only when its detection boundary is explicit. */
export const TRANSITION_DEGRADED_ENFORCEMENT_REPORT = Object.freeze([
  'host',
  'role',
  'capability',
  'enforcement',
  'reason',
  'detection_boundary',
]);

/**
 * One source of truth per status-like fact. A carrier can be authoritative for
 * the fact it stores without becoming an authority for another lifecycle fact.
 */
export const TRANSITION_FACTS = Object.freeze([
  {
    fact: 'contract_readiness',
    canonicalSource: 'trusted_task_contract_baseline',
    owner: 'maintainer',
    carriers: {
      files: '.agenticloop/task-contract-history/<task-id>.jsonl',
      github: 'verified immutable GitHub task-contract comment',
    },
    freshness: 'baseline digest equals the current material task-contract projection',
    authority: 'authoritative',
  },
  {
    fact: 'runtime_blocked_state',
    canonicalSource: 'current_structured_blocked_result',
    owner: 'producing_role',
    carriers: {
      files: 'role-return receipt referenced by task history',
      github: 'role-return receipt referenced by task issue or review carrier',
    },
    freshness: 'the blocker names the current transition identity and unsatisfied preconditions',
    authority: 'authoritative_for_resumption_only',
  },
  {
    fact: 'task_lifecycle_status',
    canonicalSource: 'durable_task_record_status',
    owner: 'maintainer',
    carriers: {
      files: 'task-file frontmatter',
      github: 'task-issue body frontmatter',
    },
    freshness: 'record digest and trusted contract chain are current for a material transition',
    authority: 'authoritative',
  },
  {
    fact: 'labels',
    canonicalSource: 'backend_label_set',
    owner: 'backend_projection',
    carriers: {
      files: 'not applicable',
      github: 'issue labels',
    },
    freshness: 'refetched after the owning transition reconciliation',
    authority: 'authoritative_for_label_presence_only',
  },
  {
    fact: 'comments',
    canonicalSource: 'typed_comment_or_history_carrier',
    owner: 'carrier_producer',
    carriers: {
      files: 'append-only task history sections or event log when enabled',
      github: 'issue comments and pull-request review bodies',
    },
    freshness: 'carrier identity, author trust, and referenced artifact are current where required',
    authority: 'authoritative_only_for_its_typed_record',
  },
  {
    fact: 'review_readiness',
    canonicalSource: 'exact_head_review_entry_receipt',
    owner: 'review_preparation_gate',
    carriers: {
      files: 'exact implementation_artifact and review-entry receipt',
      github: 'exact PR head review-preparation packet',
    },
    freshness: 'reviewed artifact equals the current implementation artifact or PR head',
    authority: 'authoritative',
  },
  {
    fact: 'review_verdict',
    canonicalSource: 'maintainer_review_result',
    owner: 'maintainer',
    carriers: {
      files: 'review status and append-only review history',
      github: 'trusted current-head review marker',
    },
    freshness: 'verdict binds the exact current reviewed artifact',
    authority: 'authoritative',
  },
  {
    fact: 'audit_state',
    canonicalSource: 'audit_record_and_append_only_report_history',
    owner: 'auditor_for_report; audit_cli_for_persistence',
    carriers: {
      files: '.agenticloop/audits/<audit-id>.md',
      github: '.agenticloop/audits/<audit-id>.md',
    },
    freshness: 'certified artifact and covered-task set equal the frozen current candidate',
    authority: 'authoritative',
  },
  {
    fact: 'terminal_closeout',
    canonicalSource: 'current_provenanced_closeout_marker',
    owner: 'maintainer_closeout',
    carriers: {
      files: 'closeout marker on the resolved task carrier',
      github: 'trusted closeout status comment or review body',
    },
    freshness: 'marker gate digest, candidate artifact, covered tasks, and predecessor are current',
    authority: 'authoritative',
  },
]);

/** Authority is not inferred from a task-body status, label, comment, or prose. */
export const TRANSITION_AUTHORITIES = Object.freeze([
  {
    action: 'request_and_activation_identity',
    authority: 'operator_and_parser_controlled_adapter',
    requiredEvidence: 'operator expected SHA-256 and parser-normalized activation receipt',
    refusal: 'unsupported_or_identity_mismatch',
  },
  {
    action: 'blocked_result_resumption',
    authority: 'producing_role_or_explicitly_redelegated_owner',
    requiredEvidence: 'current blocked result, preconditions, and resume transition identity',
    refusal: 'blocked_result_remains_nontransferable',
  },
  {
    action: 'exceptional_verification',
    authority: 'named_disposition_owner',
    requiredEvidence: 'failed or unavailable check, evidence, proposed disposition, and next transition',
    refusal: 'exception_requested',
  },
  {
    action: 'destructive_or_scope_changing_recovery',
    authority: 'human_authority',
    requiredEvidence: 'typed human disposition bound to the blocked result and exact recovery',
    refusal: 'human_authority_required',
  },
  {
    action: 'terminal_closeout',
    authority: 'maintainer_closeout',
    requiredEvidence: 'current closeout packet and successful closeout gate',
    refusal: 'closeout_gate_required',
  },
]);

/**
 * The identity chain starts with an operator digest, not a model-authored
 * restatement. Each later identity is evidence for its own boundary only.
 */
export const TRANSITION_IDENTITY_CHAIN = Object.freeze([
  {
    boundary: 'operator_request',
    identity: 'operator_supplied_expected_request_digest',
    owner: 'operator',
    requiredEvidence: 'SHA-256 of the exact authorized UTF-8 request supplied out of band',
    freshness: 'immutable for the activation attempt',
    dispositions: ['proceed', 'rejected'],
    absentOrInvalid: 'do not claim original-request integrity; report unsupported or missing identity capture',
  },
  {
    boundary: 'activation_input',
    identity: 'parser_normalized_activation_digest',
    owner: 'parser_controlled_adapter',
    requiredEvidence: 'normalized bytes, their SHA-256, and comparison to the operator digest',
    freshness: 'computed before task authoring and invalidated by any normalized-byte change',
    dispositions: ['proceed', 'rejected'],
    absentOrInvalid: 'fail before task mutation; a model restatement is advisory and cannot substitute',
  },
  {
    boundary: 'authored_task',
    identity: 'task_id_and_trusted_contract_digest',
    owner: 'maintainer',
    requiredEvidence: 'current task record plus trusted baseline or correction chain',
    freshness: 'digest equals the current material task-contract projection',
    dispositions: ['proceed', 'needs_context', 'rejected'],
    absentOrInvalid: 'quarantine mutation and dispatch until the owner repairs or establishes authority',
  },
  {
    boundary: 'dispatch',
    identity: 'preparation_packet_id_and_task_digest',
    owner: 'orchestrator',
    requiredEvidence: 'current task digest, base and dependency evidence, assigned role, and capability references',
    freshness: 'all bound identities match a refetch immediately before dispatch',
    dispositions: ['proceed', 'blocked', 'needs_context', 'rejected'],
    absentOrInvalid: 'do not dispatch; route the missing or invalid evidence to its owner',
  },
  {
    boundary: 'role_return',
    identity: 'role_return_id_and_consumed_preparation_packet_digest',
    owner: 'producing_role',
    requiredEvidence: 'schema-valid role return naming the producing role and exact artifact or blocker evidence',
    freshness: 'packet and returned artifact identities still match at import or review entry',
    dispositions: ['proceed', 'blocked', 'needs_context', 'rejected'],
    absentOrInvalid: 'reject and re-route to the producing role; another role cannot reconstruct it',
  },
  {
    boundary: 'review',
    identity: 'review_entry_receipt_and_reviewed_artifact',
    owner: 'maintainer',
    requiredEvidence: 'passing exact-head review-entry receipt and durable review result',
    freshness: 'reviewed artifact equals the current head or implementation artifact',
    dispositions: ['proceed', 'blocked', 'rejected', 'superseded'],
    absentOrInvalid: 'review-ready and review verdict remain unavailable; prose completion is advisory',
  },
  {
    boundary: 'audit',
    identity: 'audit_id_run_and_frozen_candidate_artifact',
    owner: 'auditor',
    requiredEvidence: 'fresh schema-valid Auditor report persisted unchanged against the exact candidate',
    freshness: 'candidate artifact and covered-task set equal the audit record certification boundary',
    dispositions: ['proceed', 'blocked', 'exception_requested', 'rejected'],
    absentOrInvalid: 'do not certify or close out; invalid reports return to Auditor',
  },
  {
    boundary: 'terminal_closeout',
    identity: 'closeout_packet_digest_and_marker_digest',
    owner: 'maintainer_closeout',
    requiredEvidence: 'current closeout gate packet and provenanced marker',
    freshness: 'marker inputs still match the candidate and covered task carriers',
    dispositions: ['proceed', 'blocked', 'superseded', 'rejected'],
    absentOrInvalid: 'do not claim completion; a changed carrier makes the marker stale and requires reprepare',
  },
]);

export const TRANSITION_RETURN_SHAPES = Object.freeze({
  blocked: Object.freeze({
    kind: 'agenticloop.role-return',
    schemaVersion: 1,
    required: Object.freeze([
      'return_id',
      'producer.role',
      'consumed_transition.id',
      'consumed_transition.digest',
      'disposition:blocked',
      'blocker.category',
      'blocker.evidence',
      'resume.owner',
      'resume.transition',
      'resume.preconditions',
    ]),
  }),
  exceptionalVerification: Object.freeze({
    kind: 'agenticloop.exceptional-verification',
    schemaVersion: 1,
    required: Object.freeze([
      'request_id',
      'producer.role',
      'transition.id',
      'check.identity',
      'check.failure_or_unavailability',
      'evidence',
      'proposed_disposition',
      'disposition_authority',
      'next_resumable_transition',
    ]),
  }),
});

export const TRANSITION_TERMINAL_CONTRACT = Object.freeze({
  orderedSteps: Object.freeze([
    'review_accepted',
    'integrated_or_frozen_candidate',
    'current_audit_gate_when_enabled',
    'closeout_prepare',
    'closeout_record',
    'closeout_owned_accepted_to_closed',
  ]),
  enabledAuditOrCloseout: 'only maintainer_closeout may record accepted_to_closed after a current closeout packet',
  disabledAuditAndCloseout: 'the documented generic accepted_to_closed transition remains valid for a task outside an enabled audit or closeout scope',
  staleMarker: 'a changed covered carrier, candidate, or marker input is closeout evidence stale; reprepare and record a superseding marker instead of reusing it',
});

export const TRANSITION_MARKDOWN_POLICY = Object.freeze({
  currentSchema: 'exactly one canonical H1; exactly one instance of every required heading; optional headings occur zero or one time unless their schema is explicitly append-only',
  preservation: 'a semantic rewrite preserves every unrecognized live block byte-for-byte and in relative order, or fails closed before mutation',
  idempotence: 'repeating an unchanged semantic rewrite yields byte-identical canonical content',
  legacyMigration: 'a legacy record changes schema only through an explicit migration that names source schema, target schema, authority, and preserved content proof',
});

export const TRANSITION_AUDIT_BUDGET_POLICY = Object.freeze({
  consumesAuditBudget: 'a fresh schema-valid substantive Auditor report consumes one audit run and records its cause',
  noConsumption: 'an unavailable invocation, rejected or malformed report, and report validation failure consume neither audit budget nor recovery allowance; attempt-budget rules still apply',
  productInvalidationRecovery: Object.freeze({
    kind: 'product_invalidation_recovery',
    limit: 1,
    consumption: 'uses one separately recorded recovery allowance rather than the substantive audit budget',
    requiredEvidence: 'confirmed product-caused invalidation reference, affected prior run, and maintainer-recorded cause',
    refusal: 'a second recovery attempt is blocked pending explicit human budget override',
  }),
});

export const TRANSITION_STATE_PROVENANCE = Object.freeze([
  'product_state',
  'workflow_state',
  'host_local_state',
  'unexplained_drift',
]);

/** `lease` remains a legacy synonym only for a delegation liveness window. */
export const TRANSITION_LIVENESS_VOCABULARY = Object.freeze({
  delegationLiveness: 'delegation_liveness_window: observable-step cadence, expiry, and stop condition; it grants no mutation authority',
  cancellation: 'cancellation_boundary: explicit cancellation condition and host support result; cancellation never transfers ownership',
  managedJoin: 'managed_join_plan: Maintainer-classified exact operations and freshness inputs; it is not a lease or lock',
  reviewNoMutation: 'review_no_mutation_window: exact-artifact protection during review; it is not a lease or ownership claim',
  rollback: 'digest_guarded_rollback: compare-before-write recovery against one exact current digest; it is not a lease and never overwrites changed state',
});

function validCarrierMap(carriers) {
  return carriers && TRANSITION_BACKENDS.every(backend => typeof carriers[backend] === 'string' && carriers[backend].trim());
}

/**
 * Produce the backend projection of one contract, keeping all facts and
 * vocabulary shared while exposing only the backend carrier names.
 */
export function projectTransitionContract(backend) {
  if (!TRANSITION_BACKENDS.includes(backend)) {
    throw new Error(`unsupported transition-contract backend '${String(backend)}'`);
  }
  return Object.freeze({
    contractId: TRANSITION_CONTRACT_ID,
    schemaVersion: TRANSITION_CONTRACT_SCHEMA_VERSION,
    backend,
    envelopeFields: TRANSITION_ENVELOPE_FIELDS,
    evidenceStates: TRANSITION_EVIDENCE_STATES,
    dispositions: TRANSITION_DISPOSITIONS,
    lifecycleClaims: TRANSITION_LIFECYCLE_CLAIMS,
    capabilityEnforcement: TRANSITION_CAPABILITY_ENFORCEMENT,
    facts: Object.freeze(TRANSITION_FACTS.map(({ carriers, ...fact }) => Object.freeze({ ...fact, carrier: carriers[backend] }))),
    identityChain: TRANSITION_IDENTITY_CHAIN,
  });
}

/** Validate this declarative contract without evaluating a runtime transition. */
export function validateTransitionContractDefinition() {
  const errors = [];
  if (!Number.isSafeInteger(TRANSITION_CONTRACT_SCHEMA_VERSION) || TRANSITION_CONTRACT_SCHEMA_VERSION < 1) {
    errors.push('transition contract schema version must be a positive integer');
  }
  if (!TRANSITION_CONTRACT_ID.startsWith('agenticloop.')) errors.push('transition contract id must use the agenticloop namespace');
  const expectedEnvelopeFields = ['transition', 'artifact', 'digest', 'provenance', 'freshness', 'validation', 'disposition'];
  if (TRANSITION_ENVELOPE_FIELDS.length !== expectedEnvelopeFields.length ||
    TRANSITION_ENVELOPE_FIELDS.some((field, index) => field !== expectedEnvelopeFields[index])) {
    errors.push('transition envelope fields are incomplete or out of order');
  }

  const expectedFacts = [
    'contract_readiness', 'runtime_blocked_state', 'task_lifecycle_status', 'labels', 'comments',
    'review_readiness', 'review_verdict', 'audit_state', 'terminal_closeout',
  ];
  const facts = new Set();
  for (const fact of TRANSITION_FACTS) {
    if (facts.has(fact.fact)) errors.push(`duplicate transition fact '${fact.fact}'`);
    facts.add(fact.fact);
    if (!fact.canonicalSource || !fact.owner || !fact.freshness || !fact.authority) errors.push(`transition fact '${fact.fact}' is incomplete`);
    if (!validCarrierMap(fact.carriers)) errors.push(`transition fact '${fact.fact}' lacks a files or GitHub carrier`);
  }
  for (const fact of expectedFacts) if (!facts.has(fact)) errors.push(`transition fact '${fact}' is missing`);

  const boundaries = new Set();
  for (const boundary of TRANSITION_IDENTITY_CHAIN) {
    if (boundaries.has(boundary.boundary)) errors.push(`duplicate identity boundary '${boundary.boundary}'`);
    boundaries.add(boundary.boundary);
    for (const field of ['identity', 'owner', 'requiredEvidence', 'freshness', 'absentOrInvalid']) {
      if (!String(boundary[field] ?? '').trim()) errors.push(`identity boundary '${boundary.boundary}' lacks ${field}`);
    }
    if (!Array.isArray(boundary.dispositions) || boundary.dispositions.some(item => !TRANSITION_DISPOSITIONS.includes(item))) {
      errors.push(`identity boundary '${boundary.boundary}' has an unknown disposition`);
    }
  }
  for (const boundary of ['operator_request', 'activation_input', 'authored_task', 'dispatch', 'role_return', 'review', 'audit', 'terminal_closeout']) {
    if (!boundaries.has(boundary)) errors.push(`identity boundary '${boundary}' is missing`);
  }

  if (TRANSITION_AUDIT_BUDGET_POLICY.productInvalidationRecovery.limit !== 1) {
    errors.push('product-invalidation recovery must remain bounded to one allowance');
  }
  return { ok: errors.length === 0, errors };
}
