/**
 * Static disposition catalog for diagnostic facts.  Classification describes
 * the assurance boundary; it deliberately does not change evaluator or
 * presentation behavior.
 */
import { REPAIR_POLICY } from './repair-policy.js';

export const REFUSAL_DISPOSITIONS = Object.freeze([
  'retained_hard_refusal',
  'material_human_decision',
  'agent_repairable_product_condition',
  'single_action_mechanical_repair',
  'advisory_diagnostic',
  'migration_recompute',
  'removal',
  'pending_classification',
]);

const PENDING_CLASSIFICATION = 'pending_classification';

/**
 * Every accepted code has one named live evaluation surface. Entries can name
 * more than one surface where a public command forwards the same fact. This is
 * deliberately data, rather than a source-text search, so a moved or removed
 * producer makes the ratchet fail.
 */
const PRODUCER_INVENTORY_ROWS = [
  ['src/activation-grant.js', [
    'activation.grant.malformed', 'activation.grant.expired', 'activation.grant.revoked',
    'activation.grant.repository_mismatch', 'activation.grant.out_of_scope', 'activation.binding.malformed',
    'activation.binding.unauthenticated', 'activation.binding.expired', 'activation.binding.mismatch',
    'activation.binding.task_mismatch', 'activation.binding.repository_mismatch', 'activation.binding.stale_contract',
    'activation.binding.decomposition_missing', 'activation.binding.decomposition_invalid', 'activation.binding.decomposition_changed',
  ]],
  ['src/activation-cli.js', ['activation.grant.unauthenticated', 'activation.identity.migration_required', 'activation.identity.conflict']],
  ['src/activation-resolution.js', ['activation.capture.missing', 'activation.assurance.insufficient', 'activation.policy.invalid']],
  ['src/dispatch-eligibility.js', [
    'activation.capture.malformed', 'activation.capture.mismatch', 'activation.capture.expired', 'activation.capture.unsupported',
    'task.contract.malformed', 'contract.baseline.invalid', 'readiness.base_inventory.missing', 'evidence.malformed',
    'dependency.unresolved', 'dispatch.packet.invalid', 'dispatch.packet.stale', 'capability.declaration.invalid',
    'capability.action.denied', 'parallel_scan.decomposition.invalid', 'return.assurance.insufficient',
  ]],
  ['src/task-cli.js', [
    'activation.capture.missing', 'activation.capture.malformed', 'activation.capture.mismatch', 'activation.capture.unsupported',
    'task.evidence.not_in_progress', 'task.evidence.provenance_mismatch', 'task.evidence.atomic_write',
    'task.evidence.final_validation', 'task.role_start.check_evidence_missing', 'task.role_start.check_evidence_mismatch',
    'handoff.refresh.plan.malformed', 'handoff.refresh.plan.unsupported', 'return.lane.implementation_absent',
  ]],
  ['src/task-readiness.js', [
    'scope.declaration.missing', 'scope.declaration.duplicate', 'scope.declaration.invalid', 'scope.intended_creation.missing',
    'scope.intended_creation.uncovered', 'scope.intent.invalid', 'generated.path.invalid', 'scope.glob.unmatched',
    'scope.deviation.missing', 'scope.deviation.malformed',
  ]],
  ['src/github-task-body.js', [
    'task.contract.absent', 'contract.record_marker.mutable_body', 'task.body.identity', 'task.body.invalid',
    'task.body.attribution', 'task.body.base_inventory.missing',
  ]],
  ['src/github-ready.js', ['task.body.bom', 'task.body.collapsed_newlines', 'task.body.utf8']],
  ['src/audit-cli.js', ['task.record.structure', 'audit.already_exists']],
  ['src/github-preflight.js', ['contract.baseline.missing']],
  ['src/cli.js', ['contract.baseline.stale', 'evidence.changed', 'task.evidence.lineage', 'task.evidence.contract_drift', 'task.evidence.product_head']],
  ['src/handoff-preflight.js', [
    'evidence.missing', 'task.evidence.lineage.stale', 'task.record.identity_mismatch', 'dependency.evidence.stale',
    'capability.resolution.failed', 'return.assurance.ambiguous',
  ]],
  ['src/execution-evidence.js', [
    'evidence.stale', 'execution_evidence.malformed_input', 'execution_evidence.stale_version',
    'execution_evidence.binding_mismatch', 'execution_evidence.lineage_mismatch',
  ]],
  ['src/closeout-cli.js', ['evidence.negative']],
  ['src/task-carrier-guard.js', ['task.carrier.armed']],
  ['src/dispatch-envelope.js', [
    'verification.context.missing', 'verification.context.malformed', 'verification.context.stale',
    'host.boundary.unsupported', 'parallel_scan.record.invalid', 'return.assurance.session_reported',
  ]],
  ['src/repository-state.js', ['task.mutation.unresolved']],
  ['src/execution-attempt.js', [
    'dispatch.attempt.budget_exhausted', 'dispatch.packet.conserved', 'dispatch.attempt.history_rewritten',
    'attempt_return_unbound', 'attempt_return_ambiguous', 'attempt_return_conflict', 'attempt_terminal_conflict',
  ]],
  ['src/role-session-policy.js', ['role_result.tooling_failure_repeated', 'role_result.schema.invalid']],
  ['src/closeout-waiver.js', ['compatibility.waiver_scope_retired']],
  ['src/dispatchability.js', ['task.lifecycle.not_dispatchable']],
  ['src/host-role-capabilities.js', ['capability.enforcement.degraded']],
  ['src/parallel-scan.js', ['parallel_scan.inventory.incomplete', 'parallel_scan.evidence.stale']],
  ['src/handoff-recognition.js', [
    'handoff.transition.unsupported', 'handoff.expectation.malformed', 'handoff.evidence.missing',
    'handoff.evidence.malformed', 'handoff.evidence.freshness_expired', 'handoff.evidence.schema_retired',
    'handoff.evidence.revalidation_failed', 'handoff.evidence.ambiguous_return', 'handoff.evidence.replayed',
    'handoff.evidence.mismatched', 'handoff.evidence.unsupported', 'handoff.evidence.unauthenticated',
  ]],
  ['src/tooling-failure.js', [
    'tooling_failure_input_invalid', 'tooling_failure_evidence_conflict', 'tooling_failure_write_failed',
    'tooling_failure_admission_conflict',
  ]],
  ['src/readiness-candidates.js', ['readiness.candidate.stage_failure', 'readiness.candidate.internal_failure']],
  ['src/blocked-result-authority.js', [
    'role_return.invalid', 'blocked_result.owner_mismatch', 'blocked_result.redelegation_required',
    'blocked_result.redelegation_stale', 'blocked_result.redelegation_invalid', 'blocked_result.redelegation_untrusted',
    'human_disposition.required', 'human_disposition.stale', 'human_disposition.invalid', 'human_disposition.untrusted',
  ]],
  ['src/commit-range.js', ['role_return.stale']],
  ['src/host-handoff.js', ['role_return.receipt_stale', 'role_return.producer_mismatch']],
];

// A code can be emitted by several independent evaluator modules. Keep rows
// module-first for reviewability, then merge them; Object.fromEntries silently
// overwrote earlier producer bindings for duplicate codes.
const SUPPLEMENTAL_PRODUCER_INVENTORY_ROWS = [
  ['src/activation-grant.js', ['activation.grant.unauthenticated']],
  ['src/activation-identity-migration.js', ['activation.identity.conflict']],
  ['src/activation-resolution.js', ['activation.capture.missing', 'activation.grant.revoked', 'activation.grant.unauthenticated']],
  ['src/activation-trust.js', ['activation.identity.migration_required']],
  ['src/commit-range.js', ['role_return.invalid']],
  ['src/dispatch-eligibility.js', [
    'activation.assurance.insufficient', 'activation.binding.mismatch', 'activation.binding.stale_contract',
    'activation.capture.expired', 'activation.capture.malformed', 'activation.capture.mismatch',
    'activation.capture.missing', 'activation.capture.unsupported',
    'activation.grant.expired', 'activation.grant.malformed', 'activation.grant.revoked', 'activation.grant.unauthenticated',
    'role_return.invalid', 'role_return.stale',
  ]],
  ['src/dispatch-envelope.js', [
    'blocked_result.owner_mismatch', 'capability.action.denied', 'capability.declaration.invalid',
    'dispatch.packet.stale', 'human_disposition.invalid', 'parallel_scan.decomposition.invalid',
    'return.assurance.insufficient', 'role_return.invalid',
  ]],
  ['src/exceptional-verification.js', ['role_return.invalid']],
  ['src/github-preflight.js', ['contract.baseline.invalid']],
  ['src/github-task-body.js', [
    'contract.baseline.invalid', 'contract.baseline.missing', 'evidence.negative',
    'task.contract.malformed', 'verification.context.malformed', 'verification.context.missing',
  ]],
  ['src/github-task-identity.js', ['task.body.identity']],
  ['src/handoff-consumption.js', ['handoff.evidence.malformed']],
  ['src/handoff-preflight.js', ['return.assurance.insufficient']],
  ['src/lifecycle-plan.js', ['evidence.negative']],
  ['src/parallel-scan.js', ['parallel_scan.decomposition.invalid', 'parallel_scan.record.invalid']],
  ['src/projection-reconciliation.js', ['evidence.missing']],
  ['src/public-error.js', [
    'contract.baseline.stale', 'evidence.negative', 'host.boundary.unsupported',
    'verification.context.malformed', 'verification.context.missing', 'verification.context.stale',
  ]],
  ['src/repository-state.js', ['evidence.changed', 'evidence.malformed', 'evidence.missing']],
  ['src/result-envelope.js', ['task.body.bom', 'task.body.collapsed_newlines', 'task.body.utf8', 'task.record.structure']],
  ['src/task-cli.js', ['dispatch.packet.stale', 'task.evidence.contract_drift', 'task.evidence.lineage', 'task.evidence.lineage.stale', 'task.evidence.product_head', 'task.record.identity_mismatch']],
  ['src/task-contract-baseline.js', ['contract.baseline.invalid', 'contract.baseline.missing', 'contract.baseline.stale']],
  ['src/task-readiness.js', ['dependency.unresolved', 'readiness.base_inventory.missing', 'task.contract.absent', 'task.contract.malformed', 'task.record.structure']],
  ['src/task-record-root.js', ['task.body.bom', 'task.body.collapsed_newlines', 'task.body.utf8']],
  ['src/work-unit-lease.js', ['activation.grant.expired']],
  ['src/work-unit-lease.js', ['activation.binding.mismatch']],
];

function producerInventory(rows) {
  const inventory = new Map();
  for (const [surface, codes] of rows) {
    for (const code of codes) {
      const surfaces = inventory.get(code) ?? [];
      if (!surfaces.includes(surface)) surfaces.push(surface);
      inventory.set(code, surfaces);
    }
  }
  return Object.freeze(Object.fromEntries([...inventory].map(([code, surfaces]) => [code, Object.freeze(surfaces)])));
}

const ACCEPTED_PRODUCER_INVENTORY = producerInventory([
  ...PRODUCER_INVENTORY_ROWS,
  ...SUPPLEMENTAL_PRODUCER_INVENTORY_ROWS,
]);

/**
 * Dynamic code selection is declared per module as `{ codes }`: a frozen array
 * names every statically knowable accepted-family code. When a module has an
 * unresolved selection too, `codes: 'external'` is the explicit ratchet marker
 * and `knownCodes` preserves its other statically knowable codes. The marker is
 * never a reason to silently discard the unresolved emitter.
 */
export const DYNAMIC_DIAGNOSTIC_PRODUCERS = Object.freeze({
  'src/blocked-result-authority.js': Object.freeze({ codes: Object.freeze([
    'role_return.invalid', 'blocked_result.owner_mismatch',
    'blocked_result.redelegation_required', 'blocked_result.redelegation_untrusted',
    'blocked_result.redelegation_stale', 'blocked_result.redelegation_invalid',
    'human_disposition.required', 'human_disposition.untrusted',
    'human_disposition.stale', 'human_disposition.invalid',
  ]) }),
  'src/cli-main.js': Object.freeze({ codes: 'external' }),
  'src/cli.js': Object.freeze({ codes: 'external' }),
  'src/commit-range.js': Object.freeze({ codes: 'external' }),
  'src/dispatch-eligibility.js': Object.freeze({
    codes: 'external',
    knownCodes: Object.freeze([
    'activation.capture.missing', 'activation.capture.malformed',
    'activation.capture.mismatch', 'activation.capture.unsupported',
    'dispatch.packet.invalid', 'dispatch.packet.stale',
    'role_return.invalid', 'role_return.stale', 'evidence.malformed',
    'task.contract.malformed', 'contract.baseline.invalid',
    'activation.assurance.insufficient', 'dependency.unresolved',
    'parallel_scan.decomposition.invalid', 'worktree.clean_gate.failed',
    'capability.declaration.invalid', 'return.assurance.insufficient',
    ]),
  }),
  'src/dispatch-envelope.js': Object.freeze({ codes: 'external', knownCodes: Object.freeze(['role_return.invalid']) }),
  'src/github-task-body.js': Object.freeze({
    codes: 'external',
    knownCodes: Object.freeze([
      'contract.record_marker.mutable_body', 'task.contract.malformed', 'task.contract.absent',
      'task.body.invalid', 'task.body.identity', 'contract.baseline.missing',
      'task.body.base_inventory.missing', 'task.body.attribution',
    ]),
  }),
  'src/github-preflight.js': Object.freeze({ codes: 'external' }),
  'src/handoff-recognition.js': Object.freeze({ codes: Object.freeze([
    'handoff.evidence.mismatched', 'handoff.evidence.malformed', 'handoff.evidence.freshness_expired',
    'handoff.expectation.malformed', 'handoff.evidence.missing', 'handoff.evidence.schema_retired',
    'handoff.evidence.unsupported', 'handoff.evidence.replayed', 'handoff.evidence.unauthenticated',
    'handoff.evidence.revalidation_failed', 'handoff.transition.unsupported', 'handoff.evidence.ambiguous_return',
  ]) }),
  'src/parallel-scan.js': Object.freeze({ codes: Object.freeze([
    'parallel_scan.evidence.stale', 'parallel_scan.record.invalid', 'parallel_scan.inventory.incomplete',
    'parallel_scan.decomposition.invalid',
  ]) }),
  'src/projection-reconciliation.js': Object.freeze({ codes: Object.freeze(['evidence.missing']) }),
  'src/public-error.js': Object.freeze({ codes: 'external' }),
  'src/public-result.js': Object.freeze({ codes: 'external' }),
  'src/task-cli.js': Object.freeze({ codes: Object.freeze([
    'activation.capture.missing', 'activation.capture.malformed',
    'activation.capture.mismatch', 'activation.capture.unsupported',
  ]) }),
  'src/task-readiness.js': Object.freeze({ codes: Object.freeze([
    'scope.declaration.invalid', 'scope.declaration.duplicate', 'task.contract.malformed', 'task.contract.absent',
    'scope.declaration.missing', 'generated.path.invalid', 'scope.intent.invalid', 'scope.intended_creation.uncovered',
    'readiness.base_inventory.missing', 'scope.glob.unmatched', 'scope.intended_creation.missing',
    'scope.deviation.malformed', 'scope.deviation.missing', 'dependency.unresolved',
  ]) }),
  'src/task-record-root.js': Object.freeze({ codes: Object.freeze([
    'task.body.utf8', 'task.body.bom', 'task.body.collapsed_newlines',
  ]) }),
});

// Producers emit a stable diagnostic code. Consumers only evaluate an input or
// derived fact used by that diagnostic and intentionally need not contain its
// literal; they are existence-checked rather than treated as fake emitters.
const CONSUMER_INVENTORY = Object.freeze({
  'handoff.evidence.freshness_expired': Object.freeze([
    'src/return-verification.js', 'src/return-use-freshness.js',
  ]),
  'handoff.evidence.revalidation_failed': Object.freeze([
    'src/return-verification.js', 'src/files-return-evidence.js',
  ]),
  'handoff.evidence.ambiguous_return': Object.freeze(['src/return-verification.js']),
});

const PENDING_EVALUATION_SURFACES = Object.freeze({
  'attribution.work_unit': ['src/commit-attribution.js'], 'attribution.trailer': ['src/commit-attribution.js'],
  'attribution.role': ['src/commit-attribution.js'], 'preflight.attribution': ['src/github-preflight.js'],
  'closeout.marker.stale': ['src/closeout.js'], 'review_prepare.workspace': ['src/github-review-prepare.js'],
  'review_prepare.stale_head': ['src/github-review-prepare.js'], 'review_prepare.packet': ['src/github-review-prepare.js'],
  'ready.preflight': ['src/github-ready.js'], 'ready.review_audit': ['src/github-ready.js'],
  'ready.task_identity': ['src/github-ready.js'], 'ready.cross_gate_identity': ['src/github-ready.js'],
  'review_audit.task_contract': ['src/github-review-audit.js'], 'review_audit.failure': ['src/github-review-audit.js'],
  'preflight.review_checkpoint': ['src/github-preflight.js'], 'preflight.revision_resolution': ['src/github-preflight.js'],
  'preflight.review_provenance': ['src/github-preflight.js'],
  'check.aggregate.git_probe_failed': ['src/task-cli.js'], 'worktree.clean_gate.failed': ['src/repository-state.js'],
  'audit.already_exists': ['src/audit-cli.js'], 'compatibility.waiver_scope_retired': ['src/closeout-waiver.js'],
  'state.host_local': ['src/projection-reconciliation.js'], 'projection.state.unexplained': ['src/projection-reconciliation.js'],
  'readiness.mode.invalid': ['src/task-readiness.js'], 'preflight.head_identity': ['src/github-preflight.js'],
  'preflight.summary_shape': ['src/github-preflight.js'], 'preflight.scope_deviations': ['src/github-preflight.js'],
  'preflight.task_contract': ['src/github-preflight.js'], 'preflight.path_intent': ['src/github-preflight.js'],
  'preflight.generated_paths': ['src/github-preflight.js'], 'preflight.dependencies': ['src/github-preflight.js'],
  'preflight.evidence': ['src/github-preflight.js'], 'preflight.checks': ['src/github-preflight.js'],
  'preflight.checks.task_contract': ['src/github-preflight.js'], 'preflight.task_policy': ['src/github-preflight.js'],
  'preflight.other': ['src/github-preflight.js'], 'pr_body.structural': ['src/pr-body.js'],
  'pr_body.input': ['src/preparation-input.js'], 'pr_body.snapshot': ['src/pr-body-context.js'],
  'pr_body.deprecation': ['src/cli.js'], 'pr_body.local_file': ['src/cli.js'], 'pr_body.input_format': ['src/cli.js'],
  'cli.usage': ['src/cli-main.js'], 'cli.operational': ['src/cli.js'], 'cli.unexpected': ['src/cli-main.js'],
  'projection.observation.invalid': ['src/projection-reconciliation.js'],
  'projection.carrier.not_applicable': ['src/projection-reconciliation.js'],
  'projection.evidence.superseded': ['src/projection-reconciliation.js'],
  'projection.fact.contradiction': ['src/projection-reconciliation.js'],
  'projection.authority.untyped': ['src/projection-reconciliation.js'],
});

const METADATA_OVERRIDES = Object.freeze({
  'audit.already_exists': Object.freeze({
    semanticInvalidators: 'the existing audit record is selected or rebaselined for the requested candidate and covered tasks',
  }),
  'compatibility.waiver_scope_retired': Object.freeze({
    semanticInvalidators: 'a canonical activation-only waiver supersedes the authentic historical two-scope record',
  }),
  'execution_evidence.stale_version': Object.freeze({
    semanticInvalidators: 'a current-schema recomputation supersedes the retired representation',
    proof: 'retired-schema currency is representation-only; recomputing exact execution evidence preserves the fact',
  }),
  'dispatch.packet.invalid': Object.freeze({
    semanticInvalidators: 'post-transition state changed',
    proof: 'atomic start/resume transition replaces mutable packet projections before reevaluation',
  }),
  'handoff.evidence.malformed': Object.freeze({
    semanticInvalidators: 'post-transition state changed',
    proof: 'atomic start/resume transition reevaluates the prepared-packet projection rather than preserving a liveness refusal',
  }),
  'handoff.evidence.freshness_expired': Object.freeze({
    semanticInvalidators: 'a declared handoff freshness bound is exceeded: return verifiedAt age or prepared-dispatch decomposition observedAt age',
    proof: 'finish and certification invalidation transition recomputes either expired surface - the verified return receipt or prepared-dispatch decomposition observation - without changing its bound evidence',
  }),
  'handoff.evidence.schema_retired': Object.freeze({
    semanticInvalidators: 'a current schema representation supersedes the retired packet projection',
    proof: 'a legacy packet is regenerated and validated under the current schema before role-start recognition',
  }),
  'handoff.evidence.revalidation_failed': Object.freeze({
    semanticInvalidators: 'current external verification succeeds for the exact stored return',
    proof: 'a failed external revalidation cannot be repaired by receipt freshness alone',
  }),
  'handoff.evidence.ambiguous_return': Object.freeze({
    semanticInvalidators: 'one current stored return verification is selected',
    proof: 'selection rejects competing return records instead of treating age as their only difference',
  }),
});

function defaultSemanticInvalidators(refusalClass, rationale) {
  if (refusalClass === 'migration_recompute') return 'current derivation, schema, or source state supersedes this projection';
  if (refusalClass === 'single_action_mechanical_repair') return 'the exact malformed or absent representation is repaired';
  if (refusalClass === 'advisory_diagnostic') return 'none; this observation does not authorize a refusal';
  if (refusalClass === PENDING_CLASSIFICATION) return 'pending completing-slice evaluation';
  return `none; ${rationale} remains material until replaced by authenticated current evidence`;
}

function defaultProof(code, family, refusalClass, rationale, producers) {
  if (refusalClass === PENDING_CLASSIFICATION) return `pending_wu_b2:${family}`;
  if (producers.length === 0) return `historical_no_live_producer:${code}; catalog compatibility only`;
  return `${rationale}; ${refusalClass} is emitted at ${producers.join(', ') || 'historical catalog compatibility'}`;
}

function classified(code, family, refusalClass, factOwner, rationale, repairClass) {
  const producers = ACCEPTED_PRODUCER_INVENTORY[code] ?? [];
  const consumers = CONSUMER_INVENTORY[code] ?? [];
  const pendingSurfaces = PENDING_EVALUATION_SURFACES[code] ?? [];
  const override = METADATA_OVERRIDES[code] ?? {};
  return Object.freeze({
    code, family, refusalClass, factOwner, rationale, repairClass,
    producers: producers.length > 0 ? producers : null,
    ...(consumers.length > 0 ? { consumers } : {}),
    ...(pendingSurfaces.length > 0 ? { pendingSurfaces } : {}),
    semanticInvalidators: override.semanticInvalidators ?? defaultSemanticInvalidators(refusalClass, rationale),
    proof: override.proof ?? defaultProof(code, family, refusalClass, rationale, producers),
  });
}

function pending(family, codes) {
  return codes.map(code => classified(code, family, PENDING_CLASSIFICATION, null, null, null));
}

const F1 = [
  classified('activation.capture.missing', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-absent', 'obtain authenticated capture'),
  classified('activation.capture.malformed', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-integrity', 'regenerate capture'),
  classified('activation.capture.mismatch', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-integrity', 'obtain matching capture'),
  classified('activation.capture.expired', 'F1', 'migration_recompute', 'activation_authority', 'derived-freshness', 'recompute current authorization'),
  classified('activation.capture.unsupported', 'F1', 'advisory_diagnostic', 'host_boundary', 'unsupported-observation', 'select supported boundary'),
  classified('activation.grant.malformed', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-integrity', 'repair grant encoding'),
  classified('activation.grant.unauthenticated', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-absent', 'obtain authenticated grant'),
  classified('activation.grant.expired', 'F1', 'migration_recompute', 'activation_authority', 'derived-freshness', 'recompute current authorization'),
  classified('activation.grant.revoked', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-revoked', 'obtain new authorization'),
  classified('activation.grant.repository_mismatch', 'F1', 'retained_hard_refusal', 'activation_authority', 'repository-mismatch', 'use authorized repository'),
  classified('activation.grant.out_of_scope', 'F1', 'material_human_decision', 'activation_authority', 'scope-not-authorized', 'obtain scope authorization'),
  classified('activation.binding.malformed', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-integrity', 'repair binding encoding'),
  classified('activation.binding.unauthenticated', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-absent', 'obtain authenticated binding'),
  classified('activation.binding.expired', 'F1', 'migration_recompute', 'activation_authority', 'derived-freshness', 'recompute current authorization'),
  classified('activation.binding.mismatch', 'F1', 'retained_hard_refusal', 'activation_authority', 'authorization-integrity', 'rebind current authorization'),
  classified('activation.binding.task_mismatch', 'F1', 'retained_hard_refusal', 'activation_authority', 'task-mismatch', 'use authorized task'),
  classified('activation.binding.repository_mismatch', 'F1', 'retained_hard_refusal', 'activation_authority', 'repository-mismatch', 'use authorized repository'),
  classified('activation.binding.stale_contract', 'F1', 'retained_hard_refusal', 'protected_contract', 'protected-contract-changed', 'obtain renewed authorization'),
  classified('activation.binding.decomposition_missing', 'F1', 'single_action_mechanical_repair', 'decomposition_record', 'derived-record-missing', 'recompute decomposition binding'),
  classified('activation.binding.decomposition_invalid', 'F1', 'single_action_mechanical_repair', 'decomposition_record', 'derived-record-invalid', 'recompute decomposition binding'),
  classified('activation.binding.decomposition_changed', 'F1', 'migration_recompute', 'decomposition_record', 'derived-record-changed', 'recompute decomposition binding'),
  classified('activation.assurance.insufficient', 'F1', 'material_human_decision', 'activation_authority', 'assurance-not-authorized', 'obtain authorized assurance'),
  classified('activation.identity.migration_required', 'F1', 'migration_recompute', 'activation_identity', 'identity-version-migration', 'migrate identity'),
  classified('activation.identity.conflict', 'F1', 'material_human_decision', 'activation_authority', 'authority-conflict', 'select authority'),
  classified('activation.policy.invalid', 'F1', 'single_action_mechanical_repair', 'activation_policy', 'policy-unavailable', 'repair activation policy'),
];

const F2 = [
  classified('task.contract.malformed', 'F2', 'retained_hard_refusal', 'protected_contract', 'protected-contract-invalid', 'repair contract'),
  classified('task.contract.absent', 'F2', 'retained_hard_refusal', 'protected_contract', 'authorization-intent-absent', 'create contract'),
  classified('scope.declaration.missing', 'F2', 'material_human_decision', 'protected_contract', 'scope-not-authorized', 'declare scope'),
  classified('scope.declaration.duplicate', 'F2', 'material_human_decision', 'protected_contract', 'scope-ambiguous', 'deduplicate scope'),
  classified('scope.declaration.invalid', 'F2', 'material_human_decision', 'protected_contract', 'scope-ambiguous', 'repair scope'),
  classified('scope.existing_path.missing', 'F2', 'removal', 'protected_contract', 'historical-path-inventory-check', 'remove compatibility row when consumers migrate'),
  classified('scope.intended_creation.missing', 'F2', 'material_human_decision', 'protected_contract', 'scope-not-authorized', 'declare creation'),
  classified('scope.intended_creation.uncovered', 'F2', 'material_human_decision', 'protected_contract', 'scope-not-authorized', 'cover creation'),
  classified('scope.intent.invalid', 'F2', 'material_human_decision', 'protected_contract', 'scope-ambiguous', 'repair path intent'),
  classified('generated.path.invalid', 'F2', 'material_human_decision', 'protected_contract', 'scope-ambiguous', 'repair generated-path intent'),
  classified('scope.glob.unmatched', 'F2', 'material_human_decision', 'protected_contract', 'scope-ambiguous', 'confirm scope glob'),
  classified('scope.deviation.missing', 'F2', 'material_human_decision', 'protected_contract', 'scope-not-authorized', 'declare deviation'),
  classified('scope.deviation.malformed', 'F2', 'material_human_decision', 'protected_contract', 'scope-ambiguous', 'repair deviation'),
  classified('contract.baseline.missing', 'F2', 'single_action_mechanical_repair', 'protected_contract', 'baseline-record-missing', 'establish baseline'),
  classified('contract.baseline.invalid', 'F2', 'retained_hard_refusal', 'protected_contract', 'protected-contract-invalid', 'repair baseline'),
  classified('contract.baseline.stale', 'F2', 'retained_hard_refusal', 'protected_contract', 'protected-contract-changed', 'reconcile contract'),
  classified('contract.record_marker.mutable_body', 'F2', 'single_action_mechanical_repair', 'protected_contract', 'mutable-projection-marker', 'remove marker'),
  classified('task.body.bom', 'F2', 'migration_recompute', 'task_record', 'record-normalization', 'sanitize record'),
  classified('task.body.collapsed_newlines', 'F2', 'migration_recompute', 'task_record', 'record-normalization', 'sanitize record'),
  classified('task.body.utf8', 'F2', 'retained_hard_refusal', 'task_record', 'record-integrity', 'repair encoding'),
  classified('task.record.structure', 'F2', 'migration_recompute', 'task_record', 'record-normalization', 'repair record'),
  classified('task.body.identity', 'F2', 'retained_hard_refusal', 'protected_contract', 'task-mismatch', 'repair task identity'),
  classified('task.body.invalid', 'F2', 'retained_hard_refusal', 'protected_contract', 'protected-contract-invalid', 'repair task record'),
  classified('task.body.attribution', 'F2', 'retained_hard_refusal', 'protected_contract', 'attribution-invalid', 'repair task attribution'),
  classified('task.body.base_inventory.missing', 'F2', 'single_action_mechanical_repair', 'base_inventory', 'derived-record-missing', 'supply inventory'),
  classified('readiness.base_inventory.missing', 'F2', 'single_action_mechanical_repair', 'base_inventory', 'derived-record-missing', 'supply inventory'),
  classified('evidence.missing', 'F2', 'single_action_mechanical_repair', 'evidence_record', 'evidence-missing', 'supply evidence'),
  classified('evidence.malformed', 'F2', 'single_action_mechanical_repair', 'evidence_record', 'evidence-malformed', 'repair evidence'),
  classified('evidence.stale', 'F2', 'migration_recompute', 'evidence_record', 'derived-freshness', 'recompute evidence'),
  classified('evidence.negative', 'F2', 'retained_hard_refusal', 'required_check', 'checks-failed', 'repair failed condition'),
  classified('evidence.changed', 'F2', 'migration_recompute', 'evidence_record', 'derived-record-changed', 'recompute evidence'),
  classified('task.evidence.not_in_progress', 'F2', 'retained_hard_refusal', 'attempt_state', 'lifecycle-state-invalid', 'use current lifecycle state'),
  classified('task.evidence.lineage', 'F2', 'retained_hard_refusal', 'attempt_lineage', 'lineage-ambiguous', 'resolve lineage'),
  classified('task.evidence.lineage.stale', 'F2', 'migration_recompute', 'attempt_lineage', 'derived-record-changed', 'recompute lineage'),
  classified('task.carrier.armed', 'F2', 'retained_hard_refusal', 'attempt_lineage', 'concurrent-mutation-safety', 'complete or explicitly resolve attempt'),
  classified('task.evidence.provenance_mismatch', 'F2', 'retained_hard_refusal', 'attempt_lineage', 'attribution-invalid', 'supply bound evidence'),
  classified('task.evidence.contract_drift', 'F2', 'retained_hard_refusal', 'protected_contract', 'protected-contract-changed', 'reconcile contract'),
  classified('task.evidence.atomic_write', 'F2', 'advisory_diagnostic', 'workflow_projection', 'atomic-write-unproven', 'retry atomic write'),
  classified('task.evidence.final_validation', 'F2', 'retained_hard_refusal', 'attempt_lineage', 'lineage-unproven', 'verify current lineage'),
  classified('verification.context.missing', 'F2', 'single_action_mechanical_repair', 'verification_context', 'evidence-missing', 'supply context'),
  classified('verification.context.malformed', 'F2', 'single_action_mechanical_repair', 'verification_context', 'evidence-malformed', 'repair context'),
  classified('verification.context.stale', 'F2', 'migration_recompute', 'verification_context', 'derived-freshness', 'recompute context'),
  classified('host.boundary.unsupported', 'F2', 'advisory_diagnostic', 'host_boundary', 'unsupported-observation', 'select supported boundary'),
  classified('task.record.identity_mismatch', 'F2', 'retained_hard_refusal', 'protected_contract', 'task-mismatch', 'repair record identity'),
  classified('task.evidence.product_head', 'F2', 'retained_hard_refusal', 'product_lineage', 'candidate-head-mismatch', 'use current product head'),
  classified('execution_evidence.malformed_input', 'F2', 'single_action_mechanical_repair', 'execution_evidence', 'evidence-malformed', 'repair execution evidence'),
  classified('execution_evidence.stale_version', 'F2', 'migration_recompute', 'execution_evidence', 'retired-schema-currency', 'recompute execution evidence'),
  classified('execution_evidence.binding_mismatch', 'F2', 'retained_hard_refusal', 'execution_evidence', 'evidence-binding-mismatch', 'rerun exact check'),
  classified('execution_evidence.lineage_mismatch', 'F2', 'retained_hard_refusal', 'attempt_lineage', 'lineage-ambiguous', 'recompute execution evidence'),
];

const F3 = [
  classified('dependency.unresolved', 'F3', 'retained_hard_refusal', 'dependency_state', 'dependency-unsatisfied', 'resolve dependency'),
  classified('dependency.evidence.stale', 'F3', 'migration_recompute', 'dependency_state', 'derived-freshness', 'recompute dependency state'),
  classified('dispatch.attempt.budget_exhausted', 'F3', 'material_human_decision', 'task_policy', 'attempt-policy-limit', 'change task policy'),
  classified('role_result.tooling_failure_repeated', 'F3', 'advisory_diagnostic', 'tooling_observation', 'no-progress-observation', 'diagnose tooling'),
  classified('role_result.schema.invalid', 'F3', 'single_action_mechanical_repair', 'role_result', 'result-schema-invalid', 'regenerate role result'),
  classified('task.role_start.check_evidence_missing', 'F3', 'single_action_mechanical_repair', 'dispatch_packet', 'derived-record-missing', 'initialize check evidence'),
  classified('task.role_start.check_evidence_mismatch', 'F3', 'migration_recompute', 'dispatch_packet', 'derived-record-changed', 'recompute check evidence'),
  classified('task.lifecycle.not_dispatchable', 'F3', 'retained_hard_refusal', 'attempt_state', 'lifecycle-state-invalid', 'use dispatchable state'),
  // Recovery of an unresolved write is evaluated on the same dispatch path that
  // later consumes its state; keep its acceptance proof with that transition.
  classified('task.mutation.unresolved', 'F3', 'retained_hard_refusal', 'workflow_projection', 'mutation-state-unproven', 'resolve mutation state'),
  classified('dispatch.packet.invalid', 'F3', 'single_action_mechanical_repair', 'dispatch_packet', 'packet-malformed', 'regenerate packet'),
  classified('dispatch.packet.stale', 'F3', 'migration_recompute', 'dispatch_packet', 'derived-freshness', 'recompute packet'),
  classified('dispatch.packet.conserved', 'F3', 'material_human_decision', 'attempt_lineage', 'attempt-conservation', 'complete or abandon attempt'),
  classified('dispatch.attempt.history_rewritten', 'F3', 'retained_hard_refusal', 'attempt_lineage', 'attribution-invalid', 'repair attribution'),
  classified('capability.declaration.invalid', 'F3', 'single_action_mechanical_repair', 'host_capability', 'capability-declaration-invalid', 'repair declaration'),
  classified('capability.enforcement.degraded', 'F3', 'advisory_diagnostic', 'host_capability', 'enforcement-observation', 'use authoritative boundary'),
  classified('capability.action.denied', 'F3', 'retained_hard_refusal', 'role_capability', 'role-not-authorized', 'use authorized role'),
  classified('capability.resolution.failed', 'F3', 'advisory_diagnostic', 'host_capability', 'resolution-unavailable', 'resolve capability'),
  classified('parallel_scan.inventory.incomplete', 'F3', 'retained_hard_refusal', 'parallel_ownership', 'parallel-inventory-incomplete', 'complete inventory'),
  classified('parallel_scan.record.invalid', 'F3', 'single_action_mechanical_repair', 'parallel_ownership', 'derived-record-invalid', 'regenerate scan'),
  classified('parallel_scan.evidence.stale', 'F3', 'migration_recompute', 'parallel_ownership', 'derived-freshness', 'recompute scan'),
  classified('parallel_scan.decomposition.invalid', 'F3', 'retained_hard_refusal', 'parallel_ownership', 'parallel-ownership-unproven', 'repair decomposition'),
  classified('handoff.transition.unsupported', 'F3', 'advisory_diagnostic', 'handoff_boundary', 'unsupported-transition', 'use supported transition'),
  classified('handoff.expectation.malformed', 'F3', 'single_action_mechanical_repair', 'handoff_boundary', 'expectation-malformed', 'repair expectation'),
  classified('handoff.evidence.missing', 'F3', 'single_action_mechanical_repair', 'handoff_boundary', 'evidence-missing', 'supply handoff evidence'),
  classified('handoff.evidence.malformed', 'F3', 'single_action_mechanical_repair', 'handoff_boundary', 'evidence-malformed', 'repair handoff evidence'),
  classified('handoff.evidence.replayed', 'F3', 'retained_hard_refusal', 'handoff_boundary', 'replay-defense', 'use fresh packet'),
  classified('handoff.evidence.mismatched', 'F3', 'retained_hard_refusal', 'handoff_boundary', 'handoff-binding-mismatch', 'supply matching evidence'),
  classified('handoff.evidence.unsupported', 'F3', 'advisory_diagnostic', 'handoff_boundary', 'unsupported-observation', 'use supported evidence'),
  classified('handoff.evidence.unauthenticated', 'F3', 'retained_hard_refusal', 'handoff_boundary', 'authorization-absent', 'supply authenticated evidence'),
  classified('handoff.refresh.plan.malformed', 'F3', 'single_action_mechanical_repair', 'handoff_boundary', 'refresh-plan-invalid', 'repair refresh plan'),
  classified('handoff.refresh.plan.unsupported', 'F3', 'advisory_diagnostic', 'handoff_boundary', 'unsupported-observation', 'use supported backend'),
  classified('tooling_failure_input_invalid', 'F3', 'single_action_mechanical_repair', 'tooling_observation', 'observation-input-invalid', 'repair tooling observation'),
  classified('tooling_failure_evidence_conflict', 'F3', 'migration_recompute', 'tooling_observation', 'derived-record-changed', 'recompute tooling observation'),
  classified('tooling_failure_write_failed', 'F3', 'advisory_diagnostic', 'tooling_observation', 'atomic-write-unproven', 'retry observation write'),
  classified('tooling_failure_admission_conflict', 'F3', 'migration_recompute', 'tooling_observation', 'concurrent-observation-change', 'recompute retry admission'),
];

const F4 = [
  classified('readiness.candidate.stage_failure', 'F4', 'advisory_diagnostic', 'candidate_builder', 'candidate-stage-observation', 'inspect stage diagnostic'),
  classified('readiness.candidate.internal_failure', 'F4', 'advisory_diagnostic', 'candidate_builder', 'candidate-stage-observation', 'inspect stage diagnostic'),
  classified('return.assurance.insufficient', 'F4', 'material_human_decision', 'return_assurance', 'assurance-not-authorized', 'obtain authorized assurance'),
  classified('return.assurance.ambiguous', 'F4', 'single_action_mechanical_repair', 'return_adapter', 'adapter-selection-required', 'select adapter'),
  classified('return.assurance.session_reported', 'F4', 'retained_hard_refusal', 'return_assurance', 'producer-not-authenticated', 'supply authenticated return'),
  classified('return.lane.implementation_absent', 'F4', 'retained_hard_refusal', 'product_lineage', 'product-lineage-unreachable', 'reapply implementation'),
  classified('handoff.evidence.freshness_expired', 'F4', 'migration_recompute', 'handoff_boundary', 'return-receipt-age', 'recompute return receipt'),
  classified('handoff.evidence.schema_retired', 'F4', 'migration_recompute', 'handoff_boundary', 'prepared-dispatch-schema-retired', 'regenerate prepared dispatch'),
  classified('handoff.evidence.revalidation_failed', 'F4', 'retained_hard_refusal', 'handoff_boundary', 'external-return-revalidation-failed', 'revalidate exact return'),
  classified('handoff.evidence.ambiguous_return', 'F4', 'retained_hard_refusal', 'return_identity', 'stored-return-selection-ambiguous', 'resolve return selection'),
  classified('role_return.invalid', 'F4', 'retained_hard_refusal', 'return_identity', 'return-integrity', 'regenerate return'),
  classified('role_return.stale', 'F4', 'migration_recompute', 'return_identity', 'derived-freshness', 'recompute return'),
  classified('role_return.receipt_stale', 'F4', 'migration_recompute', 'return_identity', 'receipt-schema-migration', 'reissue receipt'),
  classified('role_return.producer_mismatch', 'F4', 'retained_hard_refusal', 'return_identity', 'producer-mismatch', 'supply matching return'),
  classified('attempt_return_unbound', 'F4', 'retained_hard_refusal', 'return_identity', 'attempt-binding-missing', 'supply bound return'),
  classified('attempt_return_ambiguous', 'F4', 'retained_hard_refusal', 'return_identity', 'attempt-binding-ambiguous', 'resolve return binding'),
  classified('attempt_return_conflict', 'F4', 'retained_hard_refusal', 'return_identity', 'candidate-certification-conflict', 'resolve return conflict'),
  classified('attempt_terminal_conflict', 'F4', 'retained_hard_refusal', 'return_identity', 'candidate-certification-conflict', 'resolve terminal evidence'),
  classified('blocked_result.owner_mismatch', 'F4', 'retained_hard_refusal', 'blocked_result_authority', 'ownership-mismatch', 'use producing owner'),
  classified('blocked_result.redelegation_required', 'F4', 'retained_hard_refusal', 'blocked_result_authority', 'redelegation-authority-absent', 'supply redelegation'),
  classified('blocked_result.redelegation_stale', 'F4', 'migration_recompute', 'blocked_result_authority', 'derived-freshness', 'reissue redelegation'),
  classified('blocked_result.redelegation_invalid', 'F4', 'single_action_mechanical_repair', 'blocked_result_authority', 'redelegation-invalid', 'repair redelegation'),
  classified('blocked_result.redelegation_untrusted', 'F4', 'retained_hard_refusal', 'blocked_result_authority', 'authorization-absent', 'supply trusted redelegation'),
  classified('human_disposition.required', 'F4', 'material_human_decision', 'human_authority', 'human-decision-required', 'obtain disposition'),
  classified('human_disposition.stale', 'F4', 'migration_recompute', 'human_authority', 'derived-freshness', 'reissue disposition'),
  classified('human_disposition.invalid', 'F4', 'single_action_mechanical_repair', 'human_authority', 'disposition-invalid', 'repair disposition'),
  classified('human_disposition.untrusted', 'F4', 'retained_hard_refusal', 'human_authority', 'authorization-absent', 'supply trusted disposition'),
];

const PENDING = [
  ...pending('F5', [
    'attribution.work_unit', 'attribution.trailer', 'attribution.role', 'preflight.attribution',
  ]),
  ...pending('F6', [
    'closeout.marker.stale', 'review_prepare.workspace', 'review_prepare.stale_head', 'review_prepare.packet',
    'ready.preflight', 'ready.review_audit', 'ready.task_identity', 'ready.cross_gate_identity',
    'review_audit.task_contract', 'review_audit.failure', 'preflight.review_checkpoint',
    'preflight.revision_resolution', 'preflight.review_provenance',
  ]),
  classified('audit.already_exists', 'F6', PENDING_CLASSIFICATION, 'audit_record', 'duplicate-audit-record-prevention', 'inspect or rebaseline existing audit'),
  ...pending('F7', [
    'check.aggregate.git_probe_failed', 'worktree.clean_gate.failed', 'state.host_local',
    'projection.state.unexplained',
  ]),
  classified('compatibility.waiver_scope_retired', 'F7', PENDING_CLASSIFICATION, 'compatibility_waiver', 'retired-waiver-scope-observation', 'use canonical evidence requirements'),
  ...pending('F8', [
    'readiness.mode.invalid', 'preflight.head_identity', 'preflight.summary_shape',
    'preflight.scope_deviations', 'preflight.task_contract', 'preflight.path_intent',
    'preflight.generated_paths', 'preflight.dependencies', 'preflight.evidence',
    'preflight.checks', 'preflight.checks.task_contract', 'preflight.task_policy',
    'preflight.other', 'pr_body.structural', 'pr_body.input', 'pr_body.snapshot',
    'pr_body.deprecation', 'pr_body.local_file', 'pr_body.input_format', 'cli.usage',
    'cli.operational', 'cli.unexpected', 'projection.observation.invalid',
    'projection.carrier.not_applicable', 'projection.evidence.superseded',
    'projection.fact.contradiction', 'projection.authority.untyped',
  ]),
];

const catalog = [...F1, ...F2, ...F3, ...F4, ...PENDING];
const byCode = new Map();
for (const entry of catalog) {
  if (byCode.has(entry.code)) throw new Error(`duplicate refusal classification: ${entry.code}`);
  byCode.set(entry.code, entry);
}
for (const code of Object.keys(REPAIR_POLICY)) {
  if (!byCode.has(code)) throw new Error(`missing refusal classification: ${code}`);
}
for (const code of byCode.keys()) {
  if (!Object.hasOwn(REPAIR_POLICY, code)) throw new Error(`classification has no registered diagnostic: ${code}`);
}

export const REFUSAL_CLASSES = Object.freeze(Object.fromEntries(catalog.map(entry => [entry.code, entry])));

/** Accepted-slice entries intentionally retained at a material boundary. */
const HARD_REFUSAL_CODES = Object.freeze([
  'activation.capture.missing', 'activation.capture.malformed', 'activation.capture.mismatch',
  'activation.grant.malformed', 'activation.grant.unauthenticated', 'activation.grant.revoked',
  'activation.grant.repository_mismatch', 'activation.grant.out_of_scope',
  'activation.binding.malformed', 'activation.binding.unauthenticated', 'activation.binding.mismatch',
  'activation.binding.task_mismatch', 'activation.binding.repository_mismatch', 'activation.binding.stale_contract',
  'activation.assurance.insufficient', 'activation.identity.conflict',
  'task.contract.malformed', 'task.contract.absent', 'scope.declaration.missing',
  'scope.declaration.duplicate', 'scope.declaration.invalid',
  'scope.intended_creation.missing', 'scope.intended_creation.uncovered', 'scope.intent.invalid',
  'generated.path.invalid', 'scope.glob.unmatched', 'scope.deviation.missing', 'scope.deviation.malformed',
  'contract.baseline.invalid', 'contract.baseline.stale', 'task.body.utf8', 'task.body.identity',
  'task.body.invalid', 'task.body.attribution', 'evidence.negative', 'task.evidence.not_in_progress',
  'task.evidence.lineage', 'task.carrier.armed', 'task.evidence.provenance_mismatch',
  'task.evidence.contract_drift', 'task.evidence.final_validation', 'task.record.identity_mismatch',
  'task.mutation.unresolved', 'task.evidence.product_head', 'execution_evidence.binding_mismatch',
  'execution_evidence.lineage_mismatch', 'dependency.unresolved', 'dispatch.attempt.budget_exhausted',
  'task.lifecycle.not_dispatchable', 'dispatch.packet.conserved', 'dispatch.attempt.history_rewritten',
  'capability.action.denied', 'parallel_scan.inventory.incomplete', 'parallel_scan.decomposition.invalid',
  'handoff.evidence.replayed', 'handoff.evidence.mismatched', 'handoff.evidence.unauthenticated',
  'return.assurance.insufficient', 'return.assurance.session_reported', 'return.lane.implementation_absent',
  'handoff.evidence.revalidation_failed', 'handoff.evidence.ambiguous_return',
  'role_return.invalid', 'role_return.producer_mismatch', 'attempt_return_unbound',
  'attempt_return_ambiguous', 'attempt_return_conflict', 'attempt_terminal_conflict',
  'blocked_result.owner_mismatch', 'blocked_result.redelegation_required',
  'blocked_result.redelegation_untrusted', 'human_disposition.required', 'human_disposition.untrusted',
]);

const NEGATIVE_PROOF_BY_CODE = Object.freeze({
  'activation.capture.missing': 'Material fact: no authenticated activation capture exists. scenario: activation-capture-missing-refuses-dispatch.',
  'activation.capture.malformed': 'Material fact: activation capture integrity is unproven. scenario: malformed-capture-cannot-authorize-dispatch.',
  'activation.capture.mismatch': 'Material fact: capture does not bind this activation. scenario: mismatched-capture-blocks-reuse.',
  'activation.grant.malformed': 'Material fact: grant encoding cannot prove operator intent. scenario: malformed-grant-rejects-activation.',
  'activation.grant.unauthenticated': 'Material fact: no authenticated grant attests the scope. scenario: unsigned-grant-never-authorizes.',
  'activation.grant.revoked': 'Material fact: prior operator authorization was withdrawn. scenario: revoked-grant-cannot-be-replayed.',
  'activation.grant.repository_mismatch': 'Material fact: grant names another repository. scenario: cross-repository-grant-is-refused.',
  'activation.grant.out_of_scope': 'Material fact: requested work lies outside confirmed scope. scenario: out-of-scope-task-needs-operator-decision.',
  'activation.binding.malformed': 'Material fact: activation binding integrity is unproven. scenario: malformed-binding-rejects-transition.',
  'activation.binding.unauthenticated': 'Material fact: binding lacks authenticated authority. scenario: unsigned-binding-cannot-start-role.',
  'activation.binding.mismatch': 'Material fact: binding does not match current authorized scope. scenario: scope-expansion-binding-is-refused.',
  'activation.binding.task_mismatch': 'Material fact: binding names a different task. scenario: task-mismatch-binding-blocks-start.',
  'activation.binding.repository_mismatch': 'Material fact: binding names a different repository. scenario: repository-mismatch-binding-blocks-start.',
  'activation.binding.stale_contract': 'Material fact: protected task contract changed after binding. scenario: changed-contract-needs-renewed-authorization.',
  'activation.assurance.insufficient': 'Material fact: requested assurance exceeds the operator-approved grade. scenario: insufficient-assurance-needs-human-decision.',
  'activation.identity.conflict': 'Material fact: authority identities conflict. scenario: conflicting-authorities-require-selection.',
  'task.contract.malformed': 'Material fact: protected task contract cannot be parsed exactly. scenario: malformed-contract-cannot-dispatch.',
  'task.contract.absent': 'Material fact: no task contract declares intent. scenario: absent-contract-blocks-work.',
  'scope.declaration.missing': 'Material fact: task scope was never declared. scenario: missing-scope-needs-human-declaration.',
  'scope.declaration.duplicate': 'Material fact: competing scope declarations make intent ambiguous. scenario: duplicate-scope-needs-resolution.',
  'scope.declaration.invalid': 'Material fact: declared scope is ambiguous or invalid. scenario: invalid-scope-needs-human-repair.',
  'scope.intended_creation.missing': 'Material fact: creation intent is absent. scenario: undeclared-new-path-needs-approval.',
  'scope.intended_creation.uncovered': 'Material fact: a creation lies outside declared coverage. scenario: uncovered-creation-needs-approval.',
  'scope.intent.invalid': 'Material fact: path intent cannot delimit authorized work. scenario: invalid-path-intent-is-refused.',
  'generated.path.invalid': 'Material fact: generated-path intent is ambiguous. scenario: invalid-generated-path-needs-decision.',
  'scope.glob.unmatched': 'Material fact: scope glob cannot prove intended paths. scenario: unmatched-scope-glob-needs-confirmation.',
  'scope.deviation.missing': 'Material fact: an observed deviation lacks authorization. scenario: undeclared-deviation-blocks-transition.',
  'scope.deviation.malformed': 'Material fact: deviation record cannot prove its exception. scenario: malformed-deviation-needs-repair.',
  'contract.baseline.invalid': 'Material fact: contract baseline cannot prove protected history. scenario: invalid-baseline-blocks-reconciliation.',
  'contract.baseline.stale': 'Material fact: baseline no longer matches protected contract. scenario: stale-baseline-blocks-dispatch.',
  'task.body.utf8': 'Material fact: task body encoding is not trustworthy. scenario: invalid-utf8-task-body-is-refused.',
  'task.body.identity': 'Material fact: task record identity differs from its carrier. scenario: task-body-identity-mismatch-blocks-use.',
  'task.body.invalid': 'Material fact: task record integrity is unproven. scenario: invalid-task-body-cannot-authorize.',
  'task.body.attribution': 'Material fact: task attribution is invalid. scenario: invalid-attribution-blocks-protected-work.',
  'evidence.negative': 'Material fact: a required check has failed. scenario: negative-required-check-remains-a-guard.',
  'task.evidence.not_in_progress': 'Material fact: evidence belongs to the wrong lifecycle state. scenario: non-progress-evidence-cannot-mutate.',
  'task.evidence.lineage': 'Material fact: carrier lineage is ambiguous. scenario: ambiguous-lineage-blocks-evidence-use.',
  'task.carrier.armed': 'Material fact: another protected mutation remains unresolved. scenario: armed-carrier-prevents-concurrent-write.',
  'task.evidence.provenance_mismatch': 'Material fact: evidence is not bound to this attempt. scenario: provenance-mismatch-blocks-carrier-update.',
  'task.evidence.contract_drift': 'Material fact: evidence predates a protected contract change. scenario: contract-drift-requires-reconciliation.',
  'task.evidence.final_validation': 'Material fact: final carrier lineage is unproven. scenario: final-validation-failure-blocks-return.',
  'task.record.identity_mismatch': 'Material fact: carrier and task identities disagree. scenario: record-identity-mismatch-is-refused.',
  'task.mutation.unresolved': 'Material fact: mutation outcome is unknown. scenario: unresolved-write-cannot-be-consumed.',
  'task.evidence.product_head': 'Material fact: declared product head is not the exact candidate. scenario: wrong-product-head-blocks-return.',
  'execution_evidence.binding_mismatch': 'Material fact: execution evidence binds another check or attempt. scenario: check-binding-mismatch-is-refused.',
  'execution_evidence.lineage_mismatch': 'Material fact: execution evidence lineage is ambiguous. scenario: execution-lineage-mismatch-blocks-return.',
  'dependency.unresolved': 'Material fact: prerequisite dependency is unsatisfied. scenario: unresolved-dependency-blocks-dispatch.',
  'dispatch.attempt.budget_exhausted': 'Material fact: task policy budget is exhausted. scenario: exhausted-attempt-budget-needs-human-decision.',
  'task.lifecycle.not_dispatchable': 'Material fact: task is not in a dispatchable lifecycle state. scenario: non-dispatchable-task-cannot-start.',
  'dispatch.packet.conserved': 'Material fact: another packet is still conserved. scenario: conserved-packet-needs-complete-or-abandon.',
  'dispatch.attempt.history_rewritten': 'Material fact: attempt history attribution changed. scenario: rewritten-attempt-history-is-refused.',
  'capability.action.denied': 'Material fact: assigned role lacks the requested capability. scenario: unauthorized-role-action-is-denied.',
  'parallel_scan.inventory.incomplete': 'Material fact: concurrent ownership inventory is incomplete. scenario: incomplete-parallel-scan-blocks-dispatch.',
  'parallel_scan.decomposition.invalid': 'Material fact: parallel decomposition cannot prove exclusive ownership. scenario: invalid-parallel-decomposition-is-refused.',
  'handoff.evidence.replayed': 'Material fact: prepared dispatch packet was already consumed. scenario: replayed-packet-cannot-start-role.',
  'handoff.evidence.mismatched': 'Material fact: handoff evidence binds different identities. scenario: mismatched-handoff-cannot-authorize-transition.',
  'handoff.evidence.unauthenticated': 'Material fact: handoff evidence lacks authenticated provenance. scenario: unauthenticated-handoff-is-refused.',
  'return.assurance.insufficient': 'Material fact: return assurance is below the authorized minimum. scenario: insufficient-return-assurance-needs-decision.',
  'return.assurance.session_reported': 'Material fact: return producer is not authenticated. scenario: session-reported-return-cannot-authorize.',
  'return.lane.implementation_absent': 'Material fact: return lane lacks reachable implementation. scenario: absent-lane-artifact-blocks-return.',
  'handoff.evidence.revalidation_failed': 'Material fact: exact stored return fails current external verification. scenario: failed-return-revalidation-remains-refused.',
  'handoff.evidence.ambiguous_return': 'Material fact: current return selection is ambiguous. scenario: competing-return-records-cannot-authorize.',
  'role_return.invalid': 'Material fact: role return integrity or provenance is invalid. scenario: invalid-role-return-cannot-be-received.',
  'role_return.producer_mismatch': 'Material fact: authenticated producer differs from dispatched role. scenario: producer-mismatch-blocks-return.',
  'attempt_return_unbound': 'Material fact: return is not bound to an attempt. scenario: unbound-return-cannot-certify-candidate.',
  'attempt_return_ambiguous': 'Material fact: return binds multiple attempts. scenario: ambiguous-attempt-binding-is-refused.',
  'attempt_return_conflict': 'Material fact: one attempt has competing returns. scenario: conflicting-attempt-returns-block-certification.',
  'attempt_terminal_conflict': 'Material fact: terminal attempt evidence conflicts. scenario: terminal-conflict-blocks-certification.',
  'blocked_result.owner_mismatch': 'Material fact: blocked result owner differs from producer. scenario: owner-mismatch-cannot-resume.',
  'blocked_result.redelegation_required': 'Material fact: recovery lacks redelegation authority. scenario: missing-redelegation-blocks-recovery.',
  'blocked_result.redelegation_untrusted': 'Material fact: redelegation authority is untrusted. scenario: untrusted-redelegation-is-refused.',
  'human_disposition.required': 'Material fact: protected recovery requires a human decision. scenario: missing-human-disposition-blocks-recovery.',
  'human_disposition.untrusted': 'Material fact: human disposition provenance is untrusted. scenario: untrusted-human-disposition-is-refused.',
});

export const HARD_REFUSAL_ALLOWLIST = Object.freeze([
  ...HARD_REFUSAL_CODES.map(code => {
    const { factOwner, rationale, repairClass } = REFUSAL_CLASSES[code];
    return Object.freeze({
      code, factOwner, rationale, repairClass,
      negativeProof: NEGATIVE_PROOF_BY_CODE[code],
    });
  }),
]);

/** Codes preserved for historical compatibility but no longer emitted by runtime producers. */
export const HISTORICAL_PRODUCER_EXCEPTIONS = Object.freeze({
  'scope.existing_path.missing': 'removal disposition: catalog compatibility entry with no live runtime producer',
});

export function refusalClassFor(code) {
  const entry = REFUSAL_CLASSES[code];
  if (!entry) throw new Error(`diagnostic code lacks refusal classification: ${code}`);
  return entry;
}

/** Validate a catalog copy as well as the canonical frozen catalog. */
export function assertRefusalClassCatalog({
  policy = REPAIR_POLICY,
  classifications = REFUSAL_CLASSES,
  allowlist = HARD_REFUSAL_ALLOWLIST,
} = {}) {
  const policyCodes = Object.keys(policy).sort();
  const classificationCodes = Object.keys(classifications).sort();
  if (JSON.stringify(policyCodes) !== JSON.stringify(classificationCodes)) {
    throw new Error('registered diagnostic codes and refusal classifications differ');
  }
  const allowlisted = new Set();
  const negativeProofs = new Set();
  for (const entry of allowlist) {
    if (!entry || typeof entry.code !== 'string' || !Object.hasOwn(policy, entry.code)) {
      throw new Error(`hard-refusal allowlist has no registered diagnostic: ${entry?.code ?? '<missing>'}`);
    }
    if (allowlisted.has(entry.code)) throw new Error(`hard-refusal allowlist has duplicate diagnostic: ${entry.code}`);
    if (!entry.factOwner || !entry.rationale || !entry.repairClass || !entry.negativeProof) {
      throw new Error(`hard-refusal allowlist lacks metadata: ${entry.code}`);
    }
    if (!/(?:scenario|fixture):\s*\S|\b[a-z0-9_-]+\.test\.[cm]?js\b/i.test(entry.negativeProof)) {
      throw new Error(`hard-refusal allowlist negative proof lacks an adversarial scenario: ${entry.code}`);
    }
    if (negativeProofs.has(entry.negativeProof)) {
      throw new Error(`hard-refusal allowlist has duplicate negative proof: ${entry.code}`);
    }
    negativeProofs.add(entry.negativeProof);
    allowlisted.add(entry.code);
  }
  for (const [code, entry] of Object.entries(classifications)) {
    if (!REFUSAL_DISPOSITIONS.includes(entry.refusalClass)) {
      throw new Error(`diagnostic has unknown refusal disposition: ${code}`);
    }
    const accepted = ['F1', 'F2', 'F3', 'F4'].includes(entry.family);
    if (accepted && entry.refusalClass === PENDING_CLASSIFICATION) {
      throw new Error(`accepted family has pending classification: ${code}`);
    }
    if (accepted && (!Array.isArray(entry.producers) && !HISTORICAL_PRODUCER_EXCEPTIONS[code])) {
      throw new Error(`accepted diagnostic lacks producers: ${code}`);
    }
    if (entry.consumers !== undefined && (!Array.isArray(entry.consumers) || entry.consumers.length === 0 ||
      entry.consumers.some(consumer => typeof consumer !== 'string' || !consumer))) {
      throw new Error(`diagnostic has invalid consumers: ${code}`);
    }
    if (!entry.semanticInvalidators || !entry.proof) {
      throw new Error(`diagnostic lacks disposition metadata: ${code}`);
    }
    const hard = ['retained_hard_refusal', 'material_human_decision'].includes(entry.refusalClass);
    if (hard !== allowlisted.has(code)) {
      throw new Error(`hard-refusal allowlist is not exhaustive for diagnostic: ${code}`);
    }
  }
  return true;
}

assertRefusalClassCatalog();
