/**
 * Backend-neutral transition vocabulary shared by files and GitHub projections.
 *
 * This module is deliberately self-contained because it is also installed as
 * internal to the Agentic Loop npm package. It declares facts and boundaries;
 * it does not dispatch roles, mutate carriers, publish records, or enforce a
 * transition.
 */

export function deepFreeze(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const DEFINITION = {
  kind: 'agenticloop.transition-contract',
  contractId: 'agenticloop.transition-contract',
  schemaVersion: 1,
  supportedBackends: ['files', 'github'],
  ownership: {
    ownerKinds: ['workflow_role', 'human_actor', 'human_authority', 'component', 'contextual_role'],
    workflowRoles: [
      { roleId: 'orchestrator', defaultLabel: 'Orchestrator', escalationPrecedence: 10 },
      { roleId: 'maintainer', defaultLabel: 'Maintainer', escalationPrecedence: 20 },
      { roleId: 'engineer', defaultLabel: 'Engineer', escalationPrecedence: 30 },
      { roleId: 'auditor', defaultLabel: 'Auditor', escalationPrecedence: 40 },
    ],
    roleIdentityPolicy: {
      durableIdentity: 'roleId',
      labelUsage: 'display_only',
      semanticDigestExcludedField: 'defaultLabel',
      capabilitySource: 'agents/<roleId>.md frontmatter',
      roleIdRename: 'versioned_alias_or_explicit_migration_required',
    },
    humanActors: ['operator', 'authorized_human'],
    authorityBoundaries: ['human_authority'],
    components: [
      'parser_controlled_adapter',
      'backend_projection',
      'review_preparation_gate',
      'audit_cli',
      'canonical_closeout_path',
      'task_contract_store',
    ],
    contextualRoles: ['producing_role', 'explicitly_redelegated_owner', 'named_disposition_owner'],
  },
  envelope: {
    requiredFields: [
      'kind',
      'schemaVersion',
      'transition.id',
      'transition.expectedPredecessor',
      'artifact.kind',
      'artifact.id',
      'digest.algorithm',
      'digest.format',
      'digest.canonicalization',
      'digest.value',
      'provenance.state',
      'provenance.producer',
      'freshness.observedAt',
      'freshness.invalidatedBy',
      'validation.resultKind',
      'validation.evidenceState',
      'validation.diagnostics',
      'disposition',
    ],
    constants: {
      kind: 'agenticloop.transition-envelope',
      schemaVersion: 1,
      'digest.algorithm': 'sha256',
      'digest.format': 'sha256:<canonicalization>:<64-lowercase-hex>',
      'digest.canonicalization': 'agenticloop.transition-projection.v1',
      'validation.resultKind': 'agenticloop.validation-result',
    },
    artifactIdentity: 'backend-stable kind plus exact durable ID; display text, short commit prefixes, and mutable aliases are not exact identity',
    provenanceRule: 'producer, carrier, authority, and invocation facts are explicit; unverified claims use asserted provenance',
    freshnessRule: 'observation identity and invalidation condition are both required; changed bound input invalidates the envelope',
    requiredFieldRule: 'requiredFields is a closed order-insensitive inventory; missing, duplicate, or unknown entries are invalid',
    serializationRule: 'canonical JSON recursively sorts object keys and the validation-result set-like arrays errors, warnings, diagnostics, warningDiagnostics, and failureCategories by exact UTF-16 code-unit order of canonical JSON before SHA-256; semantically ordered arrays retain their schema order and incidental object-property or set-array insertion order carries no authority',
  },
  evidenceStates: ['current', 'missing', 'malformed', 'stale', 'negative', 'changed'],
  dispositions: [
    'proceed',
    'blocked',
    'needs_context',
    'rejected',
    'superseded',
    'exception_requested',
    'exception_accepted',
    'exception_rejected',
  ],
  evidenceTypes: [
    'structured_blocked_return',
    'exact_head_review_entry_receipt',
    'durable_review_changes_result',
    'durable_review_acceptance_result',
    'current_closeout_marker_and_gate_receipt',
  ],
  lifecycleClaims: [
    {
      claimId: 'implementation_blocked',
      evidenceType: 'structured_blocked_return',
      producer: { ownerKind: 'contextual_role', ownerId: 'producing_role' },
      authority: { ownerKind: 'contextual_role', ownerId: 'producing_role' },
      artifactBinding: 'return names the exact consumed transition ID/digest and current blocker artifact or evidence',
      invalidatedBy: 'consumed transition, blocker evidence, or resume preconditions change',
      absentOrInvalidDisposition: 'needs_context',
    },
    {
      claimId: 'implementation_ready_for_review',
      evidenceType: 'exact_head_review_entry_receipt',
      producer: { ownerKind: 'component', ownerId: 'review_preparation_gate' },
      authority: { ownerKind: 'component', ownerId: 'review_preparation_gate' },
      workOwner: { ownerKind: 'workflow_role', ownerId: 'engineer' },
      artifactBinding: 'passing review-entry receipt names the exact implementation artifact or full PR head',
      invalidatedBy: 'implementation artifact, PR head, required check evidence, or task contract changes',
      absentOrInvalidDisposition: 'blocked',
    },
    {
      claimId: 'review_changes_requested',
      evidenceType: 'durable_review_changes_result',
      producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      authority: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      artifactBinding: 'durable needs-revision result names the exact reviewed artifact and finding set',
      invalidatedBy: 'reviewed artifact changes or the result carrier is stale, malformed, or untrusted',
      absentOrInvalidDisposition: 'rejected',
    },
    {
      claimId: 'review_accepted',
      evidenceType: 'durable_review_acceptance_result',
      producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      authority: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      artifactBinding: 'durable accepted result names the exact current reviewed artifact',
      invalidatedBy: 'reviewed artifact changes or acceptance evidence becomes stale, malformed, or untrusted',
      absentOrInvalidDisposition: 'blocked',
    },
    {
      claimId: 'closeout_complete',
      evidenceType: 'current_closeout_marker_and_gate_receipt',
      producer: { ownerKind: 'component', ownerId: 'canonical_closeout_path' },
      authority: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      artifactBinding: 'current provenanced marker and gate digest bind the exact candidate, covered tasks, predecessor, and required audit state',
      invalidatedBy: 'candidate, covered task, carrier, marker predecessor, gate input, or required audit evidence changes',
      absentOrInvalidDisposition: 'blocked',
    },
  ],
  facts: [
    {
      factId: 'contract_readiness',
      canonicalSource: 'trusted_task_contract_baseline',
      producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      persister: { ownerKind: 'component', ownerId: 'task_contract_store' },
      carriers: {
        files: { applicable: true, carrier: '.agenticloop/task-contract-history/<task-id>.jsonl' },
        github: { applicable: true, carrier: 'verified immutable GitHub task-contract comment' },
      },
      freshness: 'baseline digest equals the current material task-contract projection',
      authority: 'authoritative',
    },
    {
      factId: 'runtime_blocked_state',
      canonicalSource: 'current_structured_blocked_result',
      producer: { ownerKind: 'contextual_role', ownerId: 'producing_role' },
      persister: { ownerKind: 'component', ownerId: 'task_contract_store' },
      carriers: {
        files: { applicable: true, carrier: 'role-return receipt referenced by task history' },
        github: { applicable: true, carrier: 'role-return receipt referenced by task issue or review carrier' },
      },
      freshness: 'blocker names the current transition identity and unsatisfied preconditions',
      authority: 'authoritative_for_resumption_only',
    },
    {
      factId: 'task_lifecycle_status',
      canonicalSource: 'durable_task_record_status',
      producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      persister: { ownerKind: 'component', ownerId: 'task_contract_store' },
      carriers: {
        files: { applicable: true, carrier: 'task-file frontmatter' },
        github: { applicable: true, carrier: 'task-issue body frontmatter' },
      },
      freshness: 'record digest and trusted contract chain are current for a material transition',
      authority: 'authoritative',
    },
    {
      factId: 'labels',
      canonicalSource: 'backend_label_set',
      producer: { ownerKind: 'component', ownerId: 'backend_projection' },
      persister: { ownerKind: 'component', ownerId: 'backend_projection' },
      carriers: {
        files: { applicable: false, carrier: null },
        github: { applicable: true, carrier: 'issue labels' },
      },
      freshness: 'refetched after the owning transition reconciliation',
      authority: 'authoritative_for_label_presence_only',
    },
    {
      factId: 'comments',
      canonicalSource: 'typed_comment_or_history_carrier',
      producer: { ownerKind: 'contextual_role', ownerId: 'producing_role' },
      persister: { ownerKind: 'component', ownerId: 'backend_projection' },
      carriers: {
        files: { applicable: true, carrier: 'append-only task history sections or enabled event log' },
        github: { applicable: true, carrier: 'issue comments and pull-request review bodies' },
      },
      freshness: 'carrier identity, author trust, and referenced artifact are current where required',
      authority: 'authoritative_only_for_its_typed_record',
    },
    {
      factId: 'review_readiness',
      canonicalSource: 'exact_head_review_entry_receipt',
      producer: { ownerKind: 'component', ownerId: 'review_preparation_gate' },
      persister: { ownerKind: 'component', ownerId: 'task_contract_store' },
      carriers: {
        files: { applicable: true, carrier: 'exact implementation artifact review-entry receipt' },
        github: { applicable: true, carrier: 'exact PR-head review-preparation packet' },
      },
      freshness: 'reviewed artifact equals the current implementation artifact or PR head',
      authority: 'authoritative',
    },
    {
      factId: 'review_verdict',
      canonicalSource: 'maintainer_review_result',
      producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      persister: { ownerKind: 'component', ownerId: 'backend_projection' },
      carriers: {
        files: { applicable: true, carrier: 'review status and append-only review history' },
        github: { applicable: true, carrier: 'trusted current-head review marker' },
      },
      freshness: 'verdict binds the exact current reviewed artifact',
      authority: 'authoritative',
    },
    {
      factId: 'audit_state',
      canonicalSource: 'audit_record_and_append_only_report_history',
      producer: { ownerKind: 'workflow_role', ownerId: 'auditor' },
      persister: { ownerKind: 'component', ownerId: 'audit_cli' },
      carriers: {
        files: { applicable: true, carrier: '.agenticloop/audits/<audit-id>.md' },
        github: { applicable: true, carrier: '.agenticloop/audits/<audit-id>.md' },
      },
      freshness: 'certified artifact and covered-task set equal the frozen current candidate',
      authority: 'authoritative',
    },
    {
      factId: 'terminal_closeout',
      canonicalSource: 'current_provenanced_closeout_marker',
      producer: { ownerKind: 'component', ownerId: 'canonical_closeout_path' },
      persister: { ownerKind: 'component', ownerId: 'backend_projection' },
      carriers: {
        files: { applicable: true, carrier: 'closeout marker on the resolved task carrier' },
        github: { applicable: true, carrier: 'trusted closeout status comment or review body' },
      },
      freshness: 'marker gate digest, candidate artifact, covered tasks, and predecessor are current',
      authority: 'authoritative',
    },
  ],
  identityChain: [
    {
      boundaryId: 'operator_request',
      identity: 'operator_supplied_expected_request_digest',
      owner: { ownerKind: 'human_actor', ownerId: 'operator' },
      requiredEvidence: 'SHA-256 of the exact authorized UTF-8 request supplied out of band',
      freshness: 'immutable for the activation attempt',
      dispositions: ['proceed', 'rejected'],
      absentOrInvalid: 'report unsupported or missing original-input capture; do not invent proof',
    },
    {
      boundaryId: 'activation_input',
      identity: 'parser_normalized_activation_digest',
      owner: { ownerKind: 'component', ownerId: 'parser_controlled_adapter' },
      requiredEvidence: 'normalized bytes, versioned digest, and comparison to the operator digest',
      freshness: 'computed before task authoring and invalidated by any normalized-byte change',
      dispositions: ['proceed', 'rejected'],
      absentOrInvalid: 'fail before mutation; a model restatement is advisory and cannot substitute',
    },
    {
      boundaryId: 'authored_task',
      identity: 'task_id_and_trusted_contract_digest',
      owner: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      requiredEvidence: 'current task record plus trusted baseline or correction chain',
      freshness: 'digest equals the current material task-contract projection',
      dispositions: ['proceed', 'needs_context', 'rejected'],
      absentOrInvalid: 'quarantine mutation and dispatch until the boundary owner establishes or repairs authority',
    },
    {
      boundaryId: 'dispatch',
      identity: 'preparation_packet_id_and_task_digest',
      owner: { ownerKind: 'workflow_role', ownerId: 'orchestrator' },
      requiredEvidence: 'current task digest, base and dependency evidence, assigned role, and capability references',
      freshness: 'all bound identities match a refetch immediately before dispatch',
      dispositions: ['proceed', 'blocked', 'needs_context', 'rejected'],
      absentOrInvalid: 'do not dispatch; route missing or invalid evidence to its owner',
    },
    {
      boundaryId: 'role_return',
      identity: 'role_return_id_and_consumed_preparation_packet_digest',
      owner: { ownerKind: 'contextual_role', ownerId: 'producing_role' },
      requiredEvidence: 'schema-valid role return naming its producer and exact artifact or blocker evidence',
      freshness: 'packet and returned artifact identities still match at import or review entry',
      dispositions: ['proceed', 'blocked', 'needs_context', 'rejected'],
      absentOrInvalid: 'reject and reroute to the producing role; another role cannot reconstruct it',
    },
    {
      boundaryId: 'review',
      identity: 'review_entry_receipt_and_reviewed_artifact',
      owner: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      requiredEvidence: 'passing exact-head review-entry receipt and durable review result',
      freshness: 'reviewed artifact equals the current head or implementation artifact',
      dispositions: ['proceed', 'blocked', 'rejected', 'superseded'],
      absentOrInvalid: 'review-ready and verdict remain unavailable; prose completion is advisory',
    },
    {
      boundaryId: 'audit',
      identity: 'audit_id_run_and_frozen_candidate_artifact',
      owner: { ownerKind: 'workflow_role', ownerId: 'auditor' },
      requiredEvidence: 'fresh schema-valid owning-role report persisted unchanged against the exact candidate',
      freshness: 'candidate artifact and covered-task set equal the certification boundary',
      dispositions: ['proceed', 'blocked', 'exception_requested', 'rejected'],
      absentOrInvalid: 'do not certify or close out; invalid reports return to the owning role',
    },
    {
      boundaryId: 'terminal_closeout',
      identity: 'closeout_packet_digest_and_marker_digest',
      owner: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      requiredEvidence: 'current closeout gate packet and provenanced marker',
      freshness: 'marker inputs still match the candidate and covered-task carriers',
      dispositions: ['proceed', 'blocked', 'superseded', 'rejected'],
      absentOrInvalid: 'do not claim completion; changed input requires reprepare and a superseding marker',
    },
  ],
  authorityRules: [
    {
      actionId: 'request_and_activation_identity',
      authority: { ownerKind: 'human_actor', ownerId: 'operator' },
      cooperatingOwner: { ownerKind: 'component', ownerId: 'parser_controlled_adapter' },
      requiredEvidence: 'expected digest and parser-normalized input receipt',
      refusalDisposition: 'rejected',
    },
    {
      actionId: 'blocked_result_resumption',
      authority: { ownerKind: 'contextual_role', ownerId: 'producing_role' },
      alternateAuthority: { ownerKind: 'contextual_role', ownerId: 'explicitly_redelegated_owner' },
      requiredEvidence: 'current blocked result, resume transition, and preconditions',
      refusalDisposition: 'blocked',
    },
    {
      actionId: 'exceptional_verification',
      authority: { ownerKind: 'contextual_role', ownerId: 'named_disposition_owner' },
      requiredEvidence: 'failed or unavailable check, evidence, proposed disposition, and next transition',
      refusalDisposition: 'exception_requested',
    },
    {
      actionId: 'destructive_or_scope_changing_recovery',
      authority: { ownerKind: 'human_authority', ownerId: 'human_authority' },
      requiredEvidence: 'typed human disposition bound to the exact blocked result and recovery',
      refusalDisposition: 'blocked',
    },
    {
      actionId: 'terminal_closeout',
      authority: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
      requiredCapability: 'task_terminal_closeout',
      requiredAction: 'closeout_owned_accepted_to_closed',
      requiredEvidence: 'current canonical closeout packet and successful closeout gate',
      refusalDisposition: 'blocked',
    },
  ],
  capabilityVocabulary: {
    enforcementStates: ['enforced', 'advisory', 'unavailable'],
    capabilities: ['task_terminal_closeout'],
    actions: ['closeout_owned_accepted_to_closed', 'generic_accepted_to_closed'],
    degradedReport: {
      requiredFields: [
        'kind',
        'schemaVersion',
        'host',
        'role',
        'capability',
        'enforcement',
        'reason',
        'detectionBoundary',
      ],
      constants: {
        kind: 'agenticloop.degraded-enforcement-report',
        schemaVersion: 1,
      },
    },
  },
  returnShapes: {
    blocked: {
      requiredFields: [
        'kind',
        'schemaVersion',
        'returnId',
        'producer.role',
        'consumedTransition.id',
        'consumedTransition.digest',
        'disposition',
        'blocker.category',
        'blocker.evidence',
        'resume.owner',
        'resume.transition',
        'resume.preconditions',
      ],
      constants: {
        kind: 'agenticloop.role-return',
        schemaVersion: 1,
        disposition: 'blocked',
      },
    },
    exceptionalVerification: {
      requiredFields: [
        'kind',
        'schemaVersion',
        'requestId',
        'producer.role',
        'transition.id',
        'check.identity',
        'check.failureOrUnavailability',
        'evidence',
        'proposedDisposition',
        'dispositionAuthority',
        'nextResumableTransition',
      ],
      constants: {
        kind: 'agenticloop.exceptional-verification',
        schemaVersion: 1,
      },
    },
  },
  terminalContract: {
    closeoutScopeRule: 'closeout scope is evidence-derived and independent of work_unit_audit; indeterminate evidence fails closed',
    auditRule: 'work_unit_audit controls only whether an existing closeout scope requires a current audit certificate',
    scopeKinds: ['configured_group', 'explicit_task_set', 'none', 'indeterminate'],
    auditModes: ['enabled', 'disabled'],
    explicitScopeEvidenceTypes: ['typed_human_selection_receipt', 'current_audit_record', 'current_closeout_marker_or_receipt'],
    scopeDerivation: {
      configured_group: 'project configuration has group_closeout === true and exact grouping membership is current and valid',
      explicit_task_set: 'durable current authority-backed evidence names the exact covered tasks using an accepted explicit-scope evidence type',
      none: 'no configured group scope and no explicit durable scope evidence exists',
      indeterminate: 'relevant configuration, membership, authority, or scope evidence is missing, malformed, stale, or contradictory',
    },
    orderedSteps: [
      'review_accepted',
      'integrated_or_frozen_candidate',
      'current_audit_gate_when_required',
      'closeout_prepare',
      'closeout_record',
      'closeout_owned_accepted_to_closed',
    ],
    owner: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
    capability: 'task_terminal_closeout',
    closeoutAction: 'closeout_owned_accepted_to_closed',
    genericAction: 'generic_accepted_to_closed',
    currentRecognition: 'isTerminalTaskTransition recognizes the allowed post-certification accepted-to-closed content delta but does not execute the closeout-owned transition',
    staleMarker: 'changed carrier, candidate, covered task, or marker input requires reprepare and a superseding marker',
    currentRuntimeMismatch: 'deriveAuditDueWorkUnits currently ignores group_closeout for non-flat profiles; P35-03 must align derivation and terminal enforcement with this resolver',
    decisionTable: [
      { caseId: 'configured_group_audit_enabled', scopeKind: 'configured_group', auditMode: 'enabled', scopeEstablished: true, auditCertificateRequired: true, genericTerminalAllowed: false, disposition: 'proceed', terminalAction: 'closeout_owned_accepted_to_closed', resumeCondition: null },
      { caseId: 'configured_group_audit_disabled', scopeKind: 'configured_group', auditMode: 'disabled', scopeEstablished: true, auditCertificateRequired: false, genericTerminalAllowed: false, disposition: 'proceed', terminalAction: 'closeout_owned_accepted_to_closed', resumeCondition: null },
      { caseId: 'explicit_task_set_audit_enabled', scopeKind: 'explicit_task_set', auditMode: 'enabled', scopeEstablished: true, auditCertificateRequired: true, genericTerminalAllowed: false, disposition: 'proceed', terminalAction: 'closeout_owned_accepted_to_closed', resumeCondition: null },
      { caseId: 'explicit_task_set_audit_disabled', scopeKind: 'explicit_task_set', auditMode: 'disabled', scopeEstablished: true, auditCertificateRequired: false, genericTerminalAllowed: false, disposition: 'proceed', terminalAction: 'closeout_owned_accepted_to_closed', resumeCondition: null },
      { caseId: 'no_scope_audit_enabled', scopeKind: 'none', auditMode: 'enabled', scopeEstablished: false, auditCertificateRequired: false, genericTerminalAllowed: true, disposition: 'proceed', terminalAction: 'generic_accepted_to_closed', resumeCondition: null },
      { caseId: 'no_scope_audit_disabled', scopeKind: 'none', auditMode: 'disabled', scopeEstablished: false, auditCertificateRequired: false, genericTerminalAllowed: true, disposition: 'proceed', terminalAction: 'generic_accepted_to_closed', resumeCondition: null },
      { caseId: 'indeterminate_audit_enabled', scopeKind: 'indeterminate', auditMode: 'enabled', scopeEstablished: false, auditCertificateRequired: false, genericTerminalAllowed: false, disposition: 'blocked', terminalAction: null, resumeCondition: 'repair_and_rederive_scope' },
      { caseId: 'indeterminate_audit_disabled', scopeKind: 'indeterminate', auditMode: 'disabled', scopeEstablished: false, auditCertificateRequired: false, genericTerminalAllowed: false, disposition: 'blocked', terminalAction: null, resumeCondition: 'repair_and_rederive_scope' },
    ],
  },
  markdownPolicy: {
    currentSchema: 'exactly one canonical H1 and exactly one instance of every required heading; optional headings occur zero or one time unless declared append-only',
    preservation: 'semantic rewrite preserves every unrecognized live block byte-for-byte and in relative order, or fails closed before mutation',
    idempotence: 'repeating an unchanged semantic rewrite yields byte-identical canonical content',
    legacyMigration: 'legacy shape changes only through explicit migration naming source schema, target schema, authority, and preserved-content proof',
  },
  auditBudgetPolicy: {
    consumesAuditBudget: 'every completed substantive report currently consumes one derived audit run',
    noConsumption: 'invocation without a report, rejected or malformed report, and report-validation failure do not consume audit budget; attempt-budget rules still apply',
    exhaustedBudget: 'existing human-approved audit budget override is required before another completed report',
    productInvalidationRecovery: {
      kind: 'product_invalidation_recovery',
      limit: 1,
      availability: 'declared_not_operational',
      enforcement: 'unavailable',
      currentBehavior: 'agents must not claim or attempt non-consuming recovery until guarded audit support exists',
      requiredEvidence: ['typed_cause', 'invalidation_reference', 'affected_prior_run', 'maintainer_recorded_cause'],
      refusal: 'second recovery requires explicit human budget override',
    },
  },
  stateProvenance: ['product_state', 'workflow_state', 'host_local_state', 'unexplained_drift'],
  livenessVocabulary: {
    delegationLiveness: 'delegation_liveness_window: observable-step cadence, expiry, and stop condition; grants no mutation authority',
    lease: 'lease: accepted external term during migration and interpreted as delegation_liveness_window',
    cancellation: 'cancellation_boundary: explicit cancellation condition and host support result; never transfers ownership',
    managedJoin: 'managed_join: existing bounded relation with a dedicated join task/artifact and exact evidence; not an execution-plan synonym, lease, or lock',
    reviewNoMutation: 'review_no_mutation_window: exact-artifact protection during review; not a lease or ownership claim',
    rollback: 'digest_guarded_rollback: compare-before-write recovery against one exact current digest; never overwrites changed state',
  },
};

export const TRANSITION_CONTRACT_DEFINITION = deepFreeze(DEFINITION);

export const WORKFLOW_ROLE_REGISTRY = TRANSITION_CONTRACT_DEFINITION.ownership.workflowRoles;
export const WORKFLOW_ROLES = Object.freeze(
  [...WORKFLOW_ROLE_REGISTRY]
    .sort((left, right) => left.escalationPrecedence - right.escalationPrecedence)
    .map(role => role.roleId)
);
export const HUMAN_AUTHORITY_BOUNDARY = TRANSITION_CONTRACT_DEFINITION.ownership.authorityBoundaries[0];
export const TRANSITION_CONTRACT_ID = TRANSITION_CONTRACT_DEFINITION.contractId;
export const TRANSITION_CONTRACT_SCHEMA_VERSION = TRANSITION_CONTRACT_DEFINITION.schemaVersion;
export const TRANSITION_BACKENDS = TRANSITION_CONTRACT_DEFINITION.supportedBackends;
export const TRANSITION_ENVELOPE_SCHEMA = TRANSITION_CONTRACT_DEFINITION.envelope;
export const TRANSITION_ENVELOPE_FIELDS = TRANSITION_ENVELOPE_SCHEMA.requiredFields;
export const TRANSITION_EVIDENCE_STATES = TRANSITION_CONTRACT_DEFINITION.evidenceStates;
export const TRANSITION_DISPOSITIONS = TRANSITION_CONTRACT_DEFINITION.dispositions;
export const TRANSITION_LIFECYCLE_CLAIMS = TRANSITION_CONTRACT_DEFINITION.lifecycleClaims;
export const TRANSITION_FACTS = TRANSITION_CONTRACT_DEFINITION.facts;
export const TRANSITION_IDENTITY_CHAIN = TRANSITION_CONTRACT_DEFINITION.identityChain;
export const TRANSITION_AUTHORITIES = TRANSITION_CONTRACT_DEFINITION.authorityRules;
export const TRANSITION_CAPABILITY_ENFORCEMENT = TRANSITION_CONTRACT_DEFINITION.capabilityVocabulary.enforcementStates;
export const TRANSITION_DEGRADED_ENFORCEMENT_REPORT = TRANSITION_CONTRACT_DEFINITION.capabilityVocabulary.degradedReport;
export const TRANSITION_RETURN_SHAPES = TRANSITION_CONTRACT_DEFINITION.returnShapes;
export const TRANSITION_TERMINAL_CONTRACT = TRANSITION_CONTRACT_DEFINITION.terminalContract;
export const TRANSITION_MARKDOWN_POLICY = TRANSITION_CONTRACT_DEFINITION.markdownPolicy;
export const TRANSITION_AUDIT_BUDGET_POLICY = TRANSITION_CONTRACT_DEFINITION.auditBudgetPolicy;
export const TRANSITION_STATE_PROVENANCE = TRANSITION_CONTRACT_DEFINITION.stateProvenance;
export const TRANSITION_LIVENESS_VOCABULARY = TRANSITION_CONTRACT_DEFINITION.livenessVocabulary;

const EXPECTED = deepFreeze({
  sections: ['kind', 'contractId', 'schemaVersion', 'supportedBackends', 'ownership', 'envelope', 'evidenceStates', 'dispositions', 'evidenceTypes', 'lifecycleClaims', 'facts', 'identityChain', 'authorityRules', 'capabilityVocabulary', 'returnShapes', 'terminalContract', 'markdownPolicy', 'auditBudgetPolicy', 'stateProvenance', 'livenessVocabulary'],
  backends: ['files', 'github'],
  ownerKinds: ['workflow_role', 'human_actor', 'human_authority', 'component', 'contextual_role'],
  roleIdentityPolicy: {
    durableIdentity: 'roleId',
    labelUsage: 'display_only',
    semanticDigestExcludedField: 'defaultLabel',
    capabilitySource: 'agents/<roleId>.md frontmatter',
    roleIdRename: 'versioned_alias_or_explicit_migration_required',
  },
  humanActors: ['operator', 'authorized_human'],
  authorityBoundaries: ['human_authority'],
  components: ['parser_controlled_adapter', 'backend_projection', 'review_preparation_gate', 'audit_cli', 'canonical_closeout_path', 'task_contract_store'],
  contextualRoles: ['producing_role', 'explicitly_redelegated_owner', 'named_disposition_owner'],
  envelopeFields: ['kind', 'schemaVersion', 'transition.id', 'transition.expectedPredecessor', 'artifact.kind', 'artifact.id', 'digest.algorithm', 'digest.format', 'digest.canonicalization', 'digest.value', 'provenance.state', 'provenance.producer', 'freshness.observedAt', 'freshness.invalidatedBy', 'validation.resultKind', 'validation.evidenceState', 'validation.diagnostics', 'disposition'],
  envelopeConstants: ['kind', 'schemaVersion', 'digest.algorithm', 'digest.format', 'digest.canonicalization', 'validation.resultKind'],
  degradedFields: ['kind', 'schemaVersion', 'host', 'role', 'capability', 'enforcement', 'reason', 'detectionBoundary'],
  degradedConstants: ['kind', 'schemaVersion'],
  blockedFields: ['kind', 'schemaVersion', 'returnId', 'producer.role', 'consumedTransition.id', 'consumedTransition.digest', 'disposition', 'blocker.category', 'blocker.evidence', 'resume.owner', 'resume.transition', 'resume.preconditions'],
  blockedConstants: ['kind', 'schemaVersion', 'disposition'],
  exceptionalFields: ['kind', 'schemaVersion', 'requestId', 'producer.role', 'transition.id', 'check.identity', 'check.failureOrUnavailability', 'evidence', 'proposedDisposition', 'dispositionAuthority', 'nextResumableTransition'],
  exceptionalConstants: ['kind', 'schemaVersion'],
  evidenceStates: ['current', 'missing', 'malformed', 'stale', 'negative', 'changed'],
  dispositions: ['proceed', 'blocked', 'needs_context', 'rejected', 'superseded', 'exception_requested', 'exception_accepted', 'exception_rejected'],
  evidenceTypes: ['structured_blocked_return', 'exact_head_review_entry_receipt', 'durable_review_changes_result', 'durable_review_acceptance_result', 'current_closeout_marker_and_gate_receipt'],
  lifecycleClaims: ['implementation_blocked', 'implementation_ready_for_review', 'review_changes_requested', 'review_accepted', 'closeout_complete'],
  facts: ['contract_readiness', 'runtime_blocked_state', 'task_lifecycle_status', 'labels', 'comments', 'review_readiness', 'review_verdict', 'audit_state', 'terminal_closeout'],
  boundaries: ['operator_request', 'activation_input', 'authored_task', 'dispatch', 'role_return', 'review', 'audit', 'terminal_closeout'],
  actions: ['request_and_activation_identity', 'blocked_result_resumption', 'exceptional_verification', 'destructive_or_scope_changing_recovery', 'terminal_closeout'],
  enforcementStates: ['enforced', 'advisory', 'unavailable'],
  capabilities: ['task_terminal_closeout'],
  transitionActions: ['closeout_owned_accepted_to_closed', 'generic_accepted_to_closed'],
  orderedTerminalSteps: ['review_accepted', 'integrated_or_frozen_candidate', 'current_audit_gate_when_required', 'closeout_prepare', 'closeout_record', 'closeout_owned_accepted_to_closed'],
  scopeKinds: ['configured_group', 'explicit_task_set', 'none', 'indeterminate'],
  auditModes: ['enabled', 'disabled'],
  explicitScopeEvidenceTypes: ['typed_human_selection_receipt', 'current_audit_record', 'current_closeout_marker_or_receipt'],
  terminalCases: ['configured_group_audit_enabled', 'configured_group_audit_disabled', 'explicit_task_set_audit_enabled', 'explicit_task_set_audit_disabled', 'no_scope_audit_enabled', 'no_scope_audit_disabled', 'indeterminate_audit_enabled', 'indeterminate_audit_disabled'],
  recoveryEvidence: ['typed_cause', 'invalidation_reference', 'affected_prior_run', 'maintainer_recorded_cause'],
  stateProvenance: ['product_state', 'workflow_state', 'host_local_state', 'unexplained_drift'],
  livenessTerms: ['delegationLiveness', 'lease', 'cancellation', 'managedJoin', 'reviewNoMutation', 'rollback'],
  lifecycleOwnership: {
    implementation_blocked: {
      producer: ['contextual_role', 'producing_role'],
      authority: ['contextual_role', 'producing_role'],
    },
    implementation_ready_for_review: {
      producer: ['component', 'review_preparation_gate'],
      authority: ['component', 'review_preparation_gate'],
      workOwner: ['workflow_role', 'engineer'],
    },
    review_changes_requested: {
      producer: ['workflow_role', 'maintainer'],
      authority: ['workflow_role', 'maintainer'],
    },
    review_accepted: {
      producer: ['workflow_role', 'maintainer'],
      authority: ['workflow_role', 'maintainer'],
    },
    closeout_complete: {
      producer: ['component', 'canonical_closeout_path'],
      authority: ['workflow_role', 'maintainer'],
    },
  },
  factOwnership: {
    contract_readiness: {
      producer: ['workflow_role', 'maintainer'],
      persister: ['component', 'task_contract_store'],
    },
    runtime_blocked_state: {
      producer: ['contextual_role', 'producing_role'],
      persister: ['component', 'task_contract_store'],
    },
    task_lifecycle_status: {
      producer: ['workflow_role', 'maintainer'],
      persister: ['component', 'task_contract_store'],
    },
    labels: {
      producer: ['component', 'backend_projection'],
      persister: ['component', 'backend_projection'],
    },
    comments: {
      producer: ['contextual_role', 'producing_role'],
      persister: ['component', 'backend_projection'],
    },
    review_readiness: {
      producer: ['component', 'review_preparation_gate'],
      persister: ['component', 'task_contract_store'],
    },
    review_verdict: {
      producer: ['workflow_role', 'maintainer'],
      persister: ['component', 'backend_projection'],
    },
    audit_state: {
      producer: ['workflow_role', 'auditor'],
      persister: ['component', 'audit_cli'],
    },
    terminal_closeout: {
      producer: ['component', 'canonical_closeout_path'],
      persister: ['component', 'backend_projection'],
    },
  },
  boundarySemantics: {
    operator_request: {
      owner: ['human_actor', 'operator'],
      dispositions: ['proceed', 'rejected'],
    },
    activation_input: {
      owner: ['component', 'parser_controlled_adapter'],
      dispositions: ['proceed', 'rejected'],
    },
    authored_task: {
      owner: ['workflow_role', 'maintainer'],
      dispositions: ['proceed', 'needs_context', 'rejected'],
    },
    dispatch: {
      owner: ['workflow_role', 'orchestrator'],
      dispositions: ['proceed', 'blocked', 'needs_context', 'rejected'],
    },
    role_return: {
      owner: ['contextual_role', 'producing_role'],
      dispositions: ['proceed', 'blocked', 'needs_context', 'rejected'],
      absentOrInvalid: 'reject and reroute to the producing role; another role cannot reconstruct it',
    },
    review: {
      owner: ['workflow_role', 'maintainer'],
      dispositions: ['proceed', 'blocked', 'rejected', 'superseded'],
    },
    audit: {
      owner: ['workflow_role', 'auditor'],
      dispositions: ['proceed', 'blocked', 'exception_requested', 'rejected'],
    },
    terminal_closeout: {
      owner: ['workflow_role', 'maintainer'],
      dispositions: ['proceed', 'blocked', 'superseded', 'rejected'],
    },
  },
  authoritySemantics: {
    request_and_activation_identity: {
      authority: ['human_actor', 'operator'],
      cooperatingOwner: ['component', 'parser_controlled_adapter'],
      refusalDisposition: 'rejected',
    },
    blocked_result_resumption: {
      authority: ['contextual_role', 'producing_role'],
      alternateAuthority: ['contextual_role', 'explicitly_redelegated_owner'],
      refusalDisposition: 'blocked',
    },
    exceptional_verification: {
      authority: ['contextual_role', 'named_disposition_owner'],
      refusalDisposition: 'exception_requested',
    },
    destructive_or_scope_changing_recovery: {
      authority: ['human_authority', 'human_authority'],
      refusalDisposition: 'blocked',
    },
    terminal_closeout: {
      authority: ['workflow_role', 'maintainer'],
      requiredCapability: 'task_terminal_closeout',
      requiredAction: 'closeout_owned_accepted_to_closed',
      refusalDisposition: 'blocked',
    },
  },
  terminalSemantics: {
    owner: ['workflow_role', 'maintainer'],
    capability: 'task_terminal_closeout',
    closeoutAction: 'closeout_owned_accepted_to_closed',
    genericAction: 'generic_accepted_to_closed',
  },
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => Array.isArray(values) && new Set(values).size === values.length;
const exactInventory = (actual, expected) => Array.isArray(actual) &&
  actual.length === expected.length && expected.every(value => actual.includes(value));
const exactSequence = (actual, expected) => Array.isArray(actual) &&
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);
const exactKeys = (actual, expected) => isObject(actual) && exactInventory(Object.keys(actual), expected);

function ownerRegistry(definition, ownerKind) {
  return {
    workflow_role: definition?.ownership?.workflowRoles?.map(role => role?.roleId),
    human_actor: definition?.ownership?.humanActors,
    human_authority: definition?.ownership?.authorityBoundaries,
    component: definition?.ownership?.components,
    contextual_role: definition?.ownership?.contextualRoles,
  }[ownerKind];
}

function validOwner(definition, owner) {
  if (!exactKeys(owner, ['ownerKind', 'ownerId']) || !definition?.ownership?.ownerKinds?.includes(owner.ownerKind)) return false;
  return ownerRegistry(definition, owner.ownerKind)?.includes(owner.ownerId) === true;
}

function expectedOwner(owner, expected) {
  return Array.isArray(expected) &&
    owner?.ownerKind === expected[0] &&
    owner?.ownerId === expected[1];
}

function expectedOptionalOwner(owner, expected) {
  return expected === undefined ? owner === undefined : expectedOwner(owner, expected);
}

function validateShape(shape, label, requiredFields, constantFields, errors, additionalProperties = []) {
  // requiredFields is a closed set, not a serialization sequence. Canonical
  // ordering belongs to the serializer/digest implementation that consumes it.
  if (!exactKeys(shape, ['requiredFields', 'constants', ...additionalProperties]) || !unique(shape.requiredFields) ||
      !exactInventory(shape.requiredFields, requiredFields) || !exactKeys(shape.constants, constantFields)) {
    errors.push(`${label} must have exact required fields and constants`);
    return;
  }
  for (const path of Object.keys(shape.constants ?? {})) {
    if (!shape.requiredFields.includes(path)) errors.push(`${label} constant '${path}' is not a required field`);
  }
}

/** Validate a candidate declarative contract without evaluating a transition. */
export function validateTransitionContractDefinition(candidate = TRANSITION_CONTRACT_DEFINITION) {
  const errors = [];
  if (!isObject(candidate)) return { ok: false, errors: ['transition contract definition must be an object'] };

  if (!exactKeys(candidate, EXPECTED.sections)) errors.push('transition contract sections are incomplete or contain unknown properties');
  if (candidate.kind !== TRANSITION_CONTRACT_ID || candidate.contractId !== TRANSITION_CONTRACT_ID) {
    errors.push(`transition contract identity must be '${TRANSITION_CONTRACT_ID}'`);
  }
  if (!Number.isSafeInteger(candidate.schemaVersion) || candidate.schemaVersion < 1) {
    errors.push('transition contract schema version must be a positive integer');
  }
  if (!exactInventory(candidate.supportedBackends, EXPECTED.backends)) errors.push('supported backend inventory is incomplete');

  const ownership = candidate.ownership;
  if (!exactKeys(ownership, ['ownerKinds', 'workflowRoles', 'roleIdentityPolicy', 'humanActors', 'authorityBoundaries', 'components', 'contextualRoles']) ||
      !exactInventory(ownership.ownerKinds, EXPECTED.ownerKinds) ||
      !exactInventory(ownership.humanActors, EXPECTED.humanActors) ||
      !exactInventory(ownership.authorityBoundaries, EXPECTED.authorityBoundaries) ||
      !exactInventory(ownership.components, EXPECTED.components) ||
      !exactInventory(ownership.contextualRoles, EXPECTED.contextualRoles)) {
    errors.push('typed ownership registry is incomplete');
  }
  const roleRegistry = Array.isArray(ownership?.workflowRoles) ? ownership.workflowRoles : [];
  if (roleRegistry.length === 0) errors.push('workflow-role registry must not be empty');
  const roleIds = [];
  const precedenceValues = [];
  for (const [index, role] of roleRegistry.entries()) {
    if (!isObject(role)) {
      errors.push(`workflow-role registry entry ${index} must be an object`);
      continue;
    }
    if (!exactKeys(role, ['roleId', 'defaultLabel', 'escalationPrecedence'])) {
      errors.push(`workflow-role registry entry ${index} must contain only roleId, defaultLabel, and escalationPrecedence`);
    }
    if (typeof role.roleId !== 'string' || !/^[a-z][a-z0-9_]*$/.test(role.roleId)) {
      errors.push(`workflow-role registry entry ${index} has an invalid roleId`);
    } else {
      roleIds.push(role.roleId);
    }
    if (!nonEmpty(role.defaultLabel)) errors.push(`workflow-role '${role.roleId ?? index}' must have a non-empty defaultLabel`);
    if (!Number.isSafeInteger(role.escalationPrecedence) || role.escalationPrecedence <= 0) {
      errors.push(`workflow-role '${role.roleId ?? index}' must have a positive safe-integer escalationPrecedence`);
    } else {
      precedenceValues.push(role.escalationPrecedence);
    }
  }
  if (!unique(roleIds)) errors.push('workflow-role registry contains duplicate roleId values');
  if (!unique(precedenceValues)) errors.push('workflow-role registry contains duplicate escalationPrecedence values');
  if (!exactKeys(ownership?.roleIdentityPolicy, Object.keys(EXPECTED.roleIdentityPolicy)) ||
      Object.entries(EXPECTED.roleIdentityPolicy).some(([key, value]) => ownership.roleIdentityPolicy?.[key] !== value)) {
    errors.push('role-identity policy is incomplete or malformed');
  }

  validateShape(candidate.envelope, 'transition envelope', EXPECTED.envelopeFields, EXPECTED.envelopeConstants, errors,
    ['artifactIdentity', 'provenanceRule', 'freshnessRule', 'requiredFieldRule', 'serializationRule']);
  for (const key of ['artifactIdentity', 'provenanceRule', 'freshnessRule', 'requiredFieldRule', 'serializationRule']) {
    if (!nonEmpty(candidate.envelope?.[key])) errors.push(`transition envelope '${key}' rule is missing`);
  }
  if (!exactInventory(candidate.envelope?.requiredFields, EXPECTED.envelopeFields) ||
      candidate.envelope?.constants?.kind !== 'agenticloop.transition-envelope' ||
      candidate.envelope?.constants?.schemaVersion !== candidate.schemaVersion ||
      candidate.envelope?.constants?.['digest.algorithm'] !== 'sha256' ||
      candidate.envelope?.constants?.['digest.format'] !== 'sha256:<canonicalization>:<64-lowercase-hex>' ||
      candidate.envelope?.constants?.['digest.canonicalization'] !== 'agenticloop.transition-projection.v1' ||
      candidate.envelope?.constants?.['validation.resultKind'] !== 'agenticloop.validation-result') {
    errors.push('transition envelope identity, digest, canonicalization, or validation constants are incomplete');
  }

  if (!unique(candidate.evidenceStates) || !exactInventory(candidate.evidenceStates, EXPECTED.evidenceStates)) errors.push('evidence-state inventory is incomplete or duplicated');
  if (!unique(candidate.dispositions) || !exactInventory(candidate.dispositions, EXPECTED.dispositions)) errors.push('disposition inventory is incomplete or duplicated');
  if (!exactInventory(candidate.evidenceTypes, EXPECTED.evidenceTypes)) errors.push('evidence type inventory is invalid');

  const claims = Array.isArray(candidate.lifecycleClaims) ? candidate.lifecycleClaims : [];
  if (!exactInventory(claims.map(item => item?.claimId), EXPECTED.lifecycleClaims)) errors.push('lifecycle claim inventory is incomplete');
  for (const claim of claims) {
    const allowedKeys = ['claimId', 'evidenceType', 'producer', 'authority', 'artifactBinding', 'invalidatedBy', 'absentOrInvalidDisposition', ...(claim.claimId === 'implementation_ready_for_review' ? ['workOwner'] : [])];
    const expectedOwnership = EXPECTED.lifecycleOwnership[claim.claimId];
    if (!candidate.evidenceTypes?.includes(claim.evidenceType) || !validOwner(candidate, claim.producer) ||
        !validOwner(candidate, claim.authority) || !nonEmpty(claim.artifactBinding) ||
        !nonEmpty(claim.invalidatedBy) || !candidate.dispositions?.includes(claim.absentOrInvalidDisposition) ||
        !exactKeys(claim, allowedKeys)) {
      errors.push(`lifecycle claim '${claim.claimId ?? 'unknown'}' has invalid evidence, ownership, binding, freshness, or disposition`);
    }
    if (!expectedOwnership ||
        !expectedOwner(claim.producer, expectedOwnership.producer) ||
        !expectedOwner(claim.authority, expectedOwnership.authority) ||
        !expectedOptionalOwner(claim.workOwner, expectedOwnership.workOwner)) {
      errors.push(`lifecycle claim '${claim.claimId ?? 'unknown'}' has inconsistent semantic ownership`);
    }
  }

  const facts = Array.isArray(candidate.facts) ? candidate.facts : [];
  if (!exactInventory(facts.map(item => item?.factId), EXPECTED.facts)) errors.push('transition fact inventory is incomplete');
  for (const fact of facts) {
    const expectedOwnership = EXPECTED.factOwnership[fact.factId];
    if (!exactKeys(fact, ['factId', 'canonicalSource', 'producer', 'persister', 'carriers', 'freshness', 'authority']) ||
        !exactKeys(fact.carriers, EXPECTED.backends) ||
        !nonEmpty(fact.canonicalSource) || !validOwner(candidate, fact.producer) || !validOwner(candidate, fact.persister) ||
        !nonEmpty(fact.freshness) || !nonEmpty(fact.authority)) {
      errors.push(`transition fact '${fact.factId ?? 'unknown'}' is incomplete`);
    }
    if (!expectedOwnership ||
        !expectedOwner(fact.producer, expectedOwnership.producer) ||
        !expectedOwner(fact.persister, expectedOwnership.persister)) {
      errors.push(`transition fact '${fact.factId ?? 'unknown'}' has inconsistent semantic ownership`);
    }
    for (const backend of candidate.supportedBackends ?? []) {
      const applicability = fact.carriers?.[backend];
      if (!exactKeys(applicability, ['applicable', 'carrier']) || typeof applicability.applicable !== 'boolean' ||
          (applicability.applicable ? !nonEmpty(applicability.carrier) : applicability.carrier !== null)) {
        errors.push(`transition fact '${fact.factId ?? 'unknown'}' has invalid ${backend} carrier applicability`);
      }
    }
  }

  const boundaries = Array.isArray(candidate.identityChain) ? candidate.identityChain : [];
  if (!exactSequence(boundaries.map(item => item?.boundaryId), EXPECTED.boundaries)) errors.push('identity-chain boundary sequence is incomplete or out of order');
  for (const boundary of boundaries) {
    const expectedBoundary = EXPECTED.boundarySemantics[boundary.boundaryId];
    if (!exactKeys(boundary, ['boundaryId', 'identity', 'owner', 'requiredEvidence', 'freshness', 'dispositions', 'absentOrInvalid']) ||
        !nonEmpty(boundary.identity) || !validOwner(candidate, boundary.owner) || !nonEmpty(boundary.requiredEvidence) ||
        !nonEmpty(boundary.freshness) || !nonEmpty(boundary.absentOrInvalid) || !unique(boundary.dispositions) ||
        boundary.dispositions.some(item => !candidate.dispositions?.includes(item))) {
      errors.push(`identity boundary '${boundary.boundaryId ?? 'unknown'}' is incomplete or has an unknown reference`);
    }
    if (!expectedBoundary ||
        !expectedOwner(boundary.owner, expectedBoundary.owner) ||
        !exactInventory(boundary.dispositions, expectedBoundary.dispositions) ||
        (expectedBoundary.absentOrInvalid !== undefined &&
          boundary.absentOrInvalid !== expectedBoundary.absentOrInvalid)) {
      errors.push(`identity boundary '${boundary.boundaryId ?? 'unknown'}' has inconsistent ownership, dispositions, or recovery policy`);
    }
  }

  const authorityRules = Array.isArray(candidate.authorityRules) ? candidate.authorityRules : [];
  if (!exactInventory(authorityRules.map(item => item?.actionId), EXPECTED.actions)) errors.push('authority action inventory is incomplete');
  for (const rule of authorityRules) {
    const allowedKeys = ['actionId', 'authority', 'requiredEvidence', 'refusalDisposition', ...(rule.alternateAuthority ? ['alternateAuthority'] : []), ...(rule.cooperatingOwner ? ['cooperatingOwner'] : []), ...(rule.requiredCapability ? ['requiredCapability'] : []), ...(rule.requiredAction ? ['requiredAction'] : [])];
    const expectedRule = EXPECTED.authoritySemantics[rule.actionId];
    if (!validOwner(candidate, rule.authority) || (rule.alternateAuthority && !validOwner(candidate, rule.alternateAuthority)) ||
        (rule.cooperatingOwner && !validOwner(candidate, rule.cooperatingOwner)) || !nonEmpty(rule.requiredEvidence) ||
        !candidate.dispositions?.includes(rule.refusalDisposition) || !exactKeys(rule, allowedKeys)) {
      errors.push(`authority action '${rule.actionId ?? 'unknown'}' has invalid ownership, evidence, or disposition`);
    }
    if (rule.requiredCapability && !candidate.capabilityVocabulary?.capabilities?.includes(rule.requiredCapability)) errors.push(`authority action '${rule.actionId}' references unknown capability`);
    if (rule.requiredAction && !candidate.capabilityVocabulary?.actions?.includes(rule.requiredAction)) errors.push(`authority action '${rule.actionId}' references unknown transition action`);
    if (!expectedRule ||
        !expectedOwner(rule.authority, expectedRule.authority) ||
        !expectedOptionalOwner(rule.alternateAuthority, expectedRule.alternateAuthority) ||
        !expectedOptionalOwner(rule.cooperatingOwner, expectedRule.cooperatingOwner) ||
        rule.requiredCapability !== expectedRule.requiredCapability ||
        rule.requiredAction !== expectedRule.requiredAction ||
        rule.refusalDisposition !== expectedRule.refusalDisposition) {
      errors.push(`authority action '${rule.actionId ?? 'unknown'}' has inconsistent semantic authority`);
    }
  }

  const capability = candidate.capabilityVocabulary;
  if (!exactKeys(capability, ['enforcementStates', 'capabilities', 'actions', 'degradedReport']) ||
      !exactInventory(capability.enforcementStates, EXPECTED.enforcementStates) ||
      !exactInventory(capability.capabilities, EXPECTED.capabilities) ||
      !exactInventory(capability.actions, EXPECTED.transitionActions)) errors.push('capability enforcement vocabulary is incomplete');
  validateShape(capability?.degradedReport, 'degraded-enforcement report', EXPECTED.degradedFields, EXPECTED.degradedConstants, errors);

  if (!exactKeys(candidate.returnShapes, ['blocked', 'exceptionalVerification'])) errors.push('return-shape registry is incomplete or contains unknown properties');
  validateShape(candidate.returnShapes?.blocked, 'blocked return shape', EXPECTED.blockedFields, EXPECTED.blockedConstants, errors);
  validateShape(candidate.returnShapes?.exceptionalVerification, 'exceptional-verification return shape', EXPECTED.exceptionalFields, EXPECTED.exceptionalConstants, errors);
  if (!isObject(candidate.returnShapes) ||
      candidate.returnShapes.blocked?.constants?.disposition !== 'blocked' ||
      candidate.returnShapes.blocked?.constants?.kind !== 'agenticloop.role-return' ||
      candidate.returnShapes.blocked?.constants?.schemaVersion !== 1 ||
      candidate.returnShapes.exceptionalVerification?.constants?.schemaVersion !== 1 ||
      candidate.returnShapes.exceptionalVerification?.constants?.kind !== 'agenticloop.exceptional-verification') {
    errors.push('blocked and exceptional-verification return shapes are incomplete');
  }

  const terminal = candidate.terminalContract;
  const terminalRows = Array.isArray(terminal?.decisionTable) ? terminal.decisionTable : [];
  if (!exactKeys(terminal, ['closeoutScopeRule', 'auditRule', 'scopeKinds', 'auditModes', 'explicitScopeEvidenceTypes', 'scopeDerivation', 'orderedSteps', 'owner', 'capability', 'closeoutAction', 'genericAction', 'currentRecognition', 'staleMarker', 'currentRuntimeMismatch', 'decisionTable']) ||
      !nonEmpty(terminal.closeoutScopeRule) || !nonEmpty(terminal.auditRule) ||
      !exactInventory(terminal.scopeKinds, EXPECTED.scopeKinds) || !exactInventory(terminal.auditModes, EXPECTED.auditModes) ||
      !exactInventory(terminal.explicitScopeEvidenceTypes, EXPECTED.explicitScopeEvidenceTypes) ||
      !exactKeys(terminal.scopeDerivation, EXPECTED.scopeKinds) || Object.values(terminal.scopeDerivation ?? {}).some(value => !nonEmpty(value)) ||
      !exactSequence(terminal.orderedSteps, EXPECTED.orderedTerminalSteps) ||
      !validOwner(candidate, terminal?.owner) || !candidate.capabilityVocabulary?.capabilities?.includes(terminal?.capability) ||
      !candidate.capabilityVocabulary?.actions?.includes(terminal?.closeoutAction) ||
      !candidate.capabilityVocabulary?.actions?.includes(terminal?.genericAction) ||
      !exactSequence(terminalRows.map(item => item?.caseId), EXPECTED.terminalCases)) {
    errors.push('terminal ownership or decision-table inventory is incomplete');
  }
  if (!expectedOwner(terminal?.owner, EXPECTED.terminalSemantics.owner) ||
      terminal?.capability !== EXPECTED.terminalSemantics.capability ||
      terminal?.closeoutAction !== EXPECTED.terminalSemantics.closeoutAction ||
      terminal?.genericAction !== EXPECTED.terminalSemantics.genericAction) {
    errors.push('terminal contract has inconsistent semantic ownership or actions');
  }
  for (const row of terminalRows) {
    const established = row.scopeKind === 'configured_group' || row.scopeKind === 'explicit_task_set';
    const expectedGeneric = row.scopeKind === 'none';
    const indeterminate = row.scopeKind === 'indeterminate';
    const casePrefix = {
      configured_group: 'configured_group',
      explicit_task_set: 'explicit_task_set',
      none: 'no_scope',
      indeterminate: 'indeterminate',
    }[row.scopeKind];
    const expectedCaseId = casePrefix ? `${casePrefix}_audit_${row.auditMode}` : '';
    if (!exactKeys(row, ['caseId', 'scopeKind', 'auditMode', 'scopeEstablished', 'auditCertificateRequired', 'genericTerminalAllowed', 'disposition', 'terminalAction', 'resumeCondition']) ||
        !terminal.scopeKinds?.includes(row.scopeKind) || !terminal.auditModes?.includes(row.auditMode) ||
        row.caseId !== expectedCaseId ||
        typeof row.scopeEstablished !== 'boolean' || typeof row.auditCertificateRequired !== 'boolean' ||
        typeof row.genericTerminalAllowed !== 'boolean' ||
        (!indeterminate && !candidate.capabilityVocabulary?.actions?.includes(row.terminalAction)) ||
        row.scopeEstablished !== established || row.auditCertificateRequired !== (established && row.auditMode === 'enabled') ||
        row.genericTerminalAllowed !== expectedGeneric ||
        row.disposition !== (indeterminate ? 'blocked' : 'proceed') ||
        row.terminalAction !== (indeterminate ? null : expectedGeneric ? terminal.genericAction : terminal.closeoutAction) ||
        row.resumeCondition !== (indeterminate ? 'repair_and_rederive_scope' : null)) {
      errors.push(`terminal decision row '${row.caseId ?? 'unknown'}' is invalid`);
    }
  }
  if (!nonEmpty(terminal?.currentRecognition) || !terminal.currentRecognition.includes('does not execute') ||
      !nonEmpty(terminal.currentRuntimeMismatch) || !terminal.currentRuntimeMismatch.includes('deriveAuditDueWorkUnits')) errors.push('terminal current-runtime recognition boundary is missing');

  if (!exactKeys(candidate.markdownPolicy, ['currentSchema', 'preservation', 'idempotence', 'legacyMigration'])) errors.push('Markdown policy contains unknown or missing properties');
  for (const key of ['currentSchema', 'preservation', 'idempotence', 'legacyMigration']) {
    if (!nonEmpty(candidate.markdownPolicy?.[key])) errors.push(`Markdown policy '${key}' is missing`);
  }
  const recovery = candidate.auditBudgetPolicy?.productInvalidationRecovery;
  if (!exactKeys(candidate.auditBudgetPolicy, ['consumesAuditBudget', 'noConsumption', 'exhaustedBudget', 'productInvalidationRecovery']) ||
      !exactKeys(recovery, ['kind', 'limit', 'availability', 'enforcement', 'currentBehavior', 'requiredEvidence', 'refusal']) ||
      recovery?.kind !== 'product_invalidation_recovery' || recovery?.limit !== 1 ||
      recovery?.availability !== 'declared_not_operational' || recovery?.enforcement !== 'unavailable' ||
      !nonEmpty(recovery?.currentBehavior) || !nonEmpty(recovery?.refusal) ||
      !exactInventory(recovery?.requiredEvidence, EXPECTED.recoveryEvidence)) {
    errors.push('product-invalidation recovery declaration or availability is invalid');
  }
  if (!nonEmpty(candidate.auditBudgetPolicy?.consumesAuditBudget) || !nonEmpty(candidate.auditBudgetPolicy?.noConsumption) || !nonEmpty(candidate.auditBudgetPolicy?.exhaustedBudget)) errors.push('audit budget policy is incomplete');
  if (!exactInventory(candidate.stateProvenance, EXPECTED.stateProvenance) || !unique(candidate.stateProvenance)) errors.push('state-provenance inventory is incomplete');
  if (!isObject(candidate.livenessVocabulary) || !exactInventory(Object.keys(candidate.livenessVocabulary), EXPECTED.livenessTerms) ||
      Object.values(candidate.livenessVocabulary ?? {}).some(value => !nonEmpty(value))) errors.push('liveness vocabulary is incomplete');

  return { ok: errors.length === 0, errors };
}

/** Resolve terminal permission from an already-established evidence-derived scope. */
export function resolveTerminalDecision({ scopeKind, auditMode } = {}) {
  const row = TRANSITION_TERMINAL_CONTRACT.decisionTable.find(item =>
    item.scopeKind === scopeKind && item.auditMode === auditMode
  );
  if (!row) {
    const error = new Error(`invalid terminal scope facts: scopeKind='${String(scopeKind)}', auditMode='${String(auditMode)}'`);
    error.name = 'TerminalScopeFactsError';
    error.code = 'transition_contract.terminal_scope_invalid';
    throw error;
  }
  return row;
}

function projectContractDefinition(backend, definition, { semantic = false } = {}) {
  if (!TRANSITION_BACKENDS.includes(backend)) {
    const error = new Error(`unsupported transition-contract backend '${String(backend)}'`);
    error.name = 'TransitionContractBackendError';
    error.code = 'transition_contract.backend_unsupported';
    error.backend = backend;
    throw error;
  }
  const validation = validateTransitionContractDefinition(definition);
  if (!validation.ok) {
    const error = new Error(`invalid transition-contract definition: ${validation.errors.join('; ')}`);
    error.name = 'TransitionContractDefinitionError';
    error.code = 'transition_contract.definition_invalid';
    error.errors = validation.errors;
    throw error;
  }
  const projection = structuredClone(definition);
  projection.projectionBackend = backend;
  projection.facts = projection.facts.map(({ carriers, ...fact }) => ({
    ...fact,
    carrierApplicability: carriers[backend],
  }));
  if (semantic) {
    const excludedField = projection.ownership.roleIdentityPolicy.semanticDigestExcludedField;
    projection.ownership.workflowRoles = projection.ownership.workflowRoles.map(role => {
      const semanticRole = { ...role };
      delete semanticRole[excludedField];
      return semanticRole;
    });
  }
  return deepFreeze(projection);
}

/**
 * Produce a complete, deeply immutable display-bearing backend projection.
 * Presentation-only labels may differ between otherwise equivalent projections.
 */
export function projectTransitionContract(backend, definition = TRANSITION_CONTRACT_DEFINITION) {
  return projectContractDefinition(backend, definition);
}

/**
 * Produce the authority/digest projection. Presentation-only role labels are
 * mechanically excluded so a label rename cannot change transition semantics.
 */
export function projectTransitionContractSemantics(backend, definition = TRANSITION_CONTRACT_DEFINITION) {
  return projectContractDefinition(backend, definition, { semantic: true });
}
