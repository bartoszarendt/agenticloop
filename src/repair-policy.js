/**
 * Stable diagnostic fact catalog.
 *
 * The catalog maps each diagnostic code to factual metadata only: category,
 * repair kind, escalation kind, and a default factual description. It never
 * names a workflow role. Role routing is derived exclusively by the
 * presentation layer from role capability bindings (`agents/*.md`
 * frontmatter), never by evaluators.
 */

/**
 * Policy names are protocol-neutral: evaluators only report facts and never
 * select a workflow transition, invoke a role, or mutate a workflow artifact.
 */
export const REPAIR_POLICY = Object.freeze({
  'task.contract.malformed': policy('task_contract', 'repair_task_contract', 'contract_reconciliation', 'Task frontmatter is malformed.'),
  'task.contract.absent': policy('task_contract', 'create_task_contract', 'contract_reconciliation', 'Task frontmatter is required.'),
  'scope.declaration.missing': policy('path_intent', 'declare_scope', 'contract_reconciliation', 'Task scope declaration is missing.'),
  'scope.declaration.duplicate': policy('path_intent', 'deduplicate_scope', 'contract_reconciliation', 'Task scope declaration contains a duplicate path.'),
  'scope.declaration.invalid': policy('path_intent', 'repair_scope_declaration', 'contract_reconciliation', 'Task scope declaration is invalid.'),
  'scope.existing_path.missing': policy('path_intent', 'classify_existing_path', 'contract_reconciliation', 'An allowed existing path is missing from the authoritative base-tree inventory.'),
  'scope.intended_creation.missing': policy('path_intent', 'declare_intended_creation', 'contract_reconciliation', 'An allowed path absent from the base tree is not declared as an intended creation.'),
  'scope.intended_creation.uncovered': policy('path_intent', 'cover_intended_creation', 'contract_reconciliation', 'An intended creation is not covered by task scope.'),
  'scope.intent.invalid': policy('path_intent', 'repair_path_intent', 'contract_reconciliation', 'Task path intent is invalid.'),
  'generated.path.invalid': policy('generated_paths', 'repair_generated_path_declaration', 'contract_reconciliation', 'Generated-path declaration is invalid.'),
  'scope.glob.unmatched': policy('path_intent', 'confirm_scope_glob', 'contract_reconciliation', 'A scope glob matches no paths in the authoritative base-tree inventory.'),
  'scope.deviation.missing': policy('scope_deviations', 'declare_exact_deviation', 'contract_reconciliation', 'Changed path is not authorized by task scope or a declared deviation.'),
  'scope.deviation.malformed': policy('scope_deviations', 'repair_deviation', 'contract_reconciliation', 'A scope deviation declaration is malformed or stale.'),
  'dependency.unresolved': policy('dependencies', 'resolve_dependency', 'dependency_escalation', 'A declared dependency is unresolved.'),
  // Distinct from `dependency.unresolved` on purpose. A snapshot that records a
  // dependency as accepted and has merely aged past its window says nothing
  // about whether the dependency is satisfied; reporting the two as one fact
  // sent the field run to escalate a dependency that was already accepted.
  'dependency.evidence.stale': policy('dependencies', 'regenerate_decomposition', 'contract_reconciliation', 'The dependency snapshot has aged past its freshness window.'),
  // `attempt_budget` is a discipline bound, not an authorization boundary, and
  // it now binds: nine attempts against a declared five went unnoticed until a
  // role counted them by hand. The repair is a task-contract decision, so it is
  // owned by the Maintainer and escalates to human authority rather than being
  // cleared by another attempt.
  'dispatch.attempt.budget_exhausted': policy('dispatch', 'repair_task_policy', 'human_authority_review', 'The task has recorded as many execution attempts as its attempt_budget allows.'),
  'role_result.tooling_failure_repeated': policy('role_result', 'repair_evidence', 'none', 'The same contract-bound tooling failure repeated without progress.'),
  'contract.baseline.missing': policy('task_contract', 'establish_baseline', 'contract_reconciliation', 'Task-contract baseline is missing.'),
  'contract.baseline.invalid': policy('task_contract', 'repair_baseline_record', 'human_authority_review', 'Task-contract baseline or correction record is invalid.'),
  'contract.baseline.stale': policy('task_contract', 'authorize_contract_correction', 'contract_reconciliation', 'Current task contract differs from the trusted baseline chain.'),
  'contract.record_marker.mutable_body': policy('task_contract', 'remove_mutable_record_marker', 'contract_reconciliation', 'A task-contract RECORD marker is present in mutable task text.'),
  'task.body.bom': policy('task_contract', 'preserve_and_sanitize_body', 'record_recovery', 'Task body begins with a UTF-8 BOM.'),
  'task.body.collapsed_newlines': policy('task_contract', 'preserve_and_sanitize_body', 'record_recovery', 'Task body has collapsed line boundaries and is not a canonical Markdown record.'),
  'task.body.utf8': policy('task_contract', 'preserve_and_sanitize_body', 'record_recovery', 'Task record is not valid UTF-8.'),
  'task.record.structure': policy('task_contract', 'repair_task_record', 'record_recovery', 'Canonical record structure is malformed or duplicated.'),
  'task.body.identity': policy('task_contract', 'repair_task_identity', 'contract_reconciliation', 'GitHub task record identity is invalid.'),
  'task.body.invalid': policy('task_contract', 'repair_task_record', 'contract_reconciliation', 'GitHub task record is invalid.'),
  'task.body.attribution': policy('task_contract', 'repair_task_attribution', 'contract_reconciliation', 'GitHub task record attribution is invalid.'),
  'task.body.base_inventory.missing': policy('path_intent', 'supply_base_inventory', 'contract_reconciliation', 'An authoritative base-tree path inventory is required.'),
  'readiness.base_inventory.missing': policy('path_intent', 'supply_base_inventory', 'contract_reconciliation', 'An authoritative base-tree path inventory is required.'),
  'readiness.candidate.stage_failure': policy('evidence', 'repair_evidence', 'record_recovery', 'A readiness candidate stage reported a blocking failure.'),
  'readiness.candidate.internal_failure': policy('evidence', 'repair_evidence', 'record_recovery', 'A readiness candidate stage failed without reporting a diagnostic cause.'),
  'attribution.work_unit': policy('attribution', 'repair_attribution_trailer', 'none', 'A work-unit commit does not carry the exact reviewed work-unit and task-set attribution.'),
  'evidence.missing': policy('evidence', 'repair_evidence', 'none', 'Required evidence was not supplied.'),
  'evidence.malformed': policy('evidence', 'repair_evidence', 'none', 'Supplied evidence is malformed.'),
  'evidence.stale': policy('evidence', 'repair_evidence', 'none', 'Supplied evidence is stale.'),
  'evidence.negative': policy('evidence', 'repair_evidence', 'none', 'Supplied evidence shows the required condition is false.'),
  'evidence.changed': policy('evidence', 'repair_evidence', 'none', 'Evidence changed after preparation or verification.'),
  'task.evidence.not_in_progress': policy('evidence', 'repair_evidence', 'none', 'The task is not in a lifecycle state that permits this role-owned evidence mutation.'),
  'task.evidence.lineage': policy('evidence', 'repair_evidence', 'none', 'The task carrier does not have one current recognized dispatch lineage.'),
  'task.evidence.provenance_mismatch': policy('evidence', 'repair_evidence', 'none', 'Structured task evidence does not bind the dispatched role, invocation, contract, and attempt.'),
  'task.evidence.contract_drift': policy('task_contract', 'repair_task_contract', 'contract_reconciliation', 'The proposed evidence mutation changes protected task-contract content or is not canonical.'),
  'task.evidence.atomic_write': policy('evidence', 'repair_evidence', 'record_recovery', 'The evidence carrier and receipt could not be committed atomically.'),
  'task.evidence.final_validation': policy('evidence', 'repair_evidence', 'record_recovery', 'Persisted evidence did not refetch as one canonical current carrier lineage.'),
  'verification.context.missing': policy('evidence', 'repair_evidence', 'none', 'Verification context was not supplied; committed state was not evaluated.'),
  'verification.context.malformed': policy('evidence', 'repair_evidence', 'none', 'Supplied verification context is malformed; committed state was not evaluated.'),
  'verification.context.stale': policy('evidence', 'repair_evidence', 'none', 'Supplied verification context is stale; committed state was not evaluated.'),
  // A well-formed registry that declares a capability this in-process boundary
  // cannot authenticate. Distinct from a malformed context and from a failed
  // authentication: nothing is forged, the boundary simply cannot prove it.
  'host.boundary.unsupported': policy('evidence', 'repair_evidence', 'none', 'The host boundary cannot support the declared capability; committed state was not evaluated.'),
  'task.record.identity_mismatch': policy('task_contract', 'repair_task_identity', 'contract_reconciliation', 'The requested task identity differs from the materialized record identity.'),
  // One shared answer to "may this task begin an execution attempt?", asked by
  // preflight, packet preparation, prepared-packet validation, and role start
  // so a green preflight cannot be refused later over the same unchanged facts.
  'task.lifecycle.not_dispatchable': policy('task_contract', 'repair_task_record', 'contract_reconciliation', 'The task lifecycle status cannot begin an execution attempt.'),
  'task.mutation.unresolved': policy('task_contract', 'repair_task_record', 'record_recovery', 'A task mutation may have committed and its exact final state could not be proven.'),
  'worktree.clean_gate.failed': policy('workspace', 'repair_review_workspace', 'none', 'The clean-worktree gate failed.'),
  'state.host_local': policy('workspace', 'repair_review_workspace', 'none', 'Host-local or preexisting state requires classification.'),
  'role_result.schema.invalid': policy('evidence', 'repair_evidence', 'none', 'The role result does not satisfy its required schema.'),
  'activation.capture.missing': policy('activation', 'repair_evidence', 'none', 'Parser-owned activation capture is required before task authoring.'),
  'activation.capture.malformed': policy('activation', 'repair_evidence', 'none', 'Activation capture is malformed or contradicts its adapter capability.'),
  'activation.capture.mismatch': policy('activation', 'repair_evidence', 'none', 'The operator and parser-normalized activation digests do not match.'),
  'activation.capture.expired': policy('activation', 'repair_evidence', 'none', 'The task-bound activation capture has expired.'),
  'activation.capture.unsupported': policy('activation', 'repair_evidence', 'none', 'The selected adapter cannot produce a proven parser-owned activation artifact.'),
  // Durable activation grants and task bindings. These reuse the activation
  // category and the existing repair kinds: the operator-facing repair is
  // always the same explicit `agenticloop activate` command, run outside the
  // agent session.
  'activation.grant.malformed': policy('activation', 'repair_evidence', 'none', 'An activation grant or task activation binding is malformed.'),
  'activation.grant.unauthenticated': policy('activation', 'repair_evidence', 'human_authority_review', 'An activation grant is unsigned or does not verify against the external operator or pinned host key.'),
  'activation.grant.expired': policy('activation', 'repair_evidence', 'none', 'The activation grant has expired.'),
  'activation.grant.revoked': policy('activation', 'repair_evidence', 'none', 'The activation grant was revoked, or a revocation record for this target is unreadable.'),
  'activation.grant.repository_mismatch': policy('activation', 'repair_evidence', 'none', 'The activation grant was issued for a different target repository.'),
  'activation.grant.out_of_scope': policy('activation', 'repair_evidence', 'none', 'The activation grant scope does not authorize this task.'),
  'activation.binding.malformed': policy('activation', 'repair_evidence', 'none', 'The task activation binding is malformed.'),
  'activation.binding.unauthenticated': policy('activation', 'repair_evidence', 'human_authority_review', 'The task activation binding is unsigned or does not verify against the external operator or pinned host key.'),
  'activation.binding.expired': policy('activation', 'repair_evidence', 'none', 'The task activation binding has expired.'),
  'activation.binding.mismatch': policy('activation', 'repair_evidence', 'none', 'The task activation binding contradicts its grant, assurance, or derivation.'),
  'activation.binding.task_mismatch': policy('activation', 'repair_evidence', 'none', 'The task activation binding authorizes a different task, backend, or carrier.'),
  'activation.binding.repository_mismatch': policy('activation', 'repair_evidence', 'none', 'The task activation binding was issued for a different target repository.'),
  'activation.binding.stale_contract': policy('activation', 'repair_evidence', 'none', 'The task contract changed after activation; the binding no longer covers the current contract.'),
  'activation.binding.decomposition_missing': policy('activation', 'repair_evidence', 'contract_reconciliation', 'A decomposition-derived activation binding requires current committed decomposition evidence.'),
  'activation.binding.decomposition_invalid': policy('activation', 'repair_evidence', 'contract_reconciliation', 'The committed decomposition evidence cannot derive this task activation binding.'),
  'activation.binding.decomposition_changed': policy('activation', 'repair_evidence', 'none', 'The committed decomposition changed after activation; derived bindings are superseded.'),
  'activation.assurance.insufficient': policy('activation', 'repair_evidence', 'human_authority_review', 'Activation assurance is below the effective minimum required by the current mode.'),
  // Operator activation material is addressed by a digest of the target's
  // canonical repository identity. When that derivation is versioned forward,
  // existing keys and deny tombstones must be migrated explicitly instead of
  // being replaced by a silently provisioned new identity.
  'activation.identity.migration_required': policy('activation', 'repair_evidence', 'human_authority_review', 'Operator activation material exists under a superseded repository identity and must be migrated before new activation authority is created.'),
  'activation.identity.conflict': policy('activation', 'repair_evidence', 'human_authority_review', 'Several operator activation keys claim this repository; the operator must choose which identity survives.'),
  'return.assurance.insufficient': policy('role_return', 'repair_evidence', 'human_authority_review', 'Return assurance is below the effective minimum required by the current mode.'),
  'return.assurance.ambiguous': policy('role_return', 'select_return_adapter', 'none', 'Multiple return adapters are available; select one with --return-adapter.'),
  'return.assurance.session_reported': policy('role_return', 'repair_evidence', 'none', 'The role return is session-reported: its producing role identity is not host-authenticated.'),
  'dispatch.packet.invalid': policy('dispatch', 'repair_evidence', 'none', 'Dispatch packet evidence is malformed or incomplete.'),
  'dispatch.packet.stale': policy('dispatch', 'repair_evidence', 'none', 'Dispatch packet evidence is stale or changed.'),
  // Conservation is a human-authority boundary, not an evidence repair: the
  // only ways past it are completing the attempt or explicitly discarding its
  // execution evidence, and the second is an operator decision.
  'dispatch.packet.conserved': policy('dispatch', 'complete_or_abandon_attempt', 'human_authority_disposition', 'A live execution attempt has recorded work and its consumed packet cannot be replaced.'),
  // Rewritten execution provenance is Maintainer-owned repair, never Engineer
  // work: the role that rewrote the history is exactly the role that cannot
  // authorize the rewrite. The field run discovered a reset after the fact, by
  // checking for surviving `git replace` refs during recovery.
  'dispatch.attempt.history_rewritten': policy('dispatch', 'repair_task_attribution', 'human_authority_review', 'Durable history in a recorded execution attempt range was rewritten or replaced.'),
  'capability.declaration.invalid': policy('role_capability', 'repair_evidence', 'none', 'The host-role capability declaration is missing, malformed, contradictory, or incomplete.'),
  'capability.enforcement.degraded': policy('role_capability', 'repair_evidence', 'none', 'The host cannot enforce this role action natively; the declared authoritative detection boundary must evaluate it.'),
  'capability.action.denied': policy('role_capability', 'repair_evidence', 'none', 'The assigned role is not authorized for the requested workflow action.'),
  'capability.resolution.failed': policy('role_capability', 'repair_evidence', 'none', 'Host-role capability resolution failed.'),
  'role_return.invalid': policy('role_return', 'repair_evidence', 'none', 'Role-return evidence is malformed or lacks trusted provenance.'),
  'role_return.stale': policy('role_return', 'repair_evidence', 'none', 'Role-return evidence no longer matches current repository facts.'),
  'role_return.receipt_stale': policy('role_return', 'repair_evidence', 'none', 'The authenticated host receipt uses a retired schema and must be reissued.'),
  'role_return.producer_mismatch': policy('role_return', 'repair_evidence', 'none', 'Authenticated producer evidence does not match the dispatched workflow role.'),
  'blocked_result.owner_mismatch': policy('role_return', 'repair_evidence', 'none', 'A blocked result remains owned by its producing workflow role.'),
  'blocked_result.redelegation_required': policy('role_return', 'repair_evidence', 'none', 'Changing a blocked result owner requires a current typed redelegation authority.'),
  'blocked_result.redelegation_stale': policy('role_return', 'repair_evidence', 'none', 'The blocked-result redelegation authority is stale.'),
  'blocked_result.redelegation_invalid': policy('role_return', 'repair_evidence', 'none', 'The blocked-result redelegation authority is malformed, mismatched, or unrelated.'),
  'blocked_result.redelegation_untrusted': policy('role_return', 'repair_evidence', 'human_authority_review', 'The blocked-result redelegation is not signed by the exact current operator-pinned authority.'),
  'human_disposition.required': policy('human_authority', 'repair_evidence', 'human_authority_review', 'A typed human disposition is required for this blocked-result recovery.'),
  'human_disposition.stale': policy('human_authority', 'repair_evidence', 'human_authority_review', 'The supplied human disposition is stale.'),
  'human_disposition.invalid': policy('human_authority', 'repair_evidence', 'human_authority_review', 'The supplied human disposition is malformed, mismatched, or unrelated.'),
  'human_disposition.untrusted': policy('human_authority', 'repair_evidence', 'human_authority_review', 'The human disposition is not signed by the exact current operator-pinned human authority.'),
  'closeout.marker.stale': policy('evidence', 'repair_evidence', 'none', 'The closeout marker is stale relative to current bound state.'),
  'readiness.mode.invalid': policy('path_intent', 'select_readiness_mode', 'none', 'Readiness mode is invalid.'),
  'preflight.head_identity': policy('head_identity', 'repair_artifact_identity', 'none', 'PR artifact identity does not match the declared head.'),
  'preflight.summary_shape': policy('summary_shape', 'repair_pr_summary', 'none', 'PR completion summary is incomplete or malformed.'),
  'preflight.scope_deviations': policy('scope_deviations', 'declare_exact_deviation', 'contract_reconciliation', 'PR paths do not match the task scope.'),
  'preflight.task_contract': policy('task_contract', 'repair_task_contract', 'contract_reconciliation', 'Task contract is invalid.'),
  'preflight.path_intent': policy('path_intent', 'repair_path_intent', 'contract_reconciliation', 'Task path intent is invalid.'),
  'preflight.generated_paths': policy('generated_paths', 'repair_generated_path_declaration', 'contract_reconciliation', 'Generated-path declaration is invalid.'),
  'preflight.dependencies': policy('dependencies', 'resolve_dependency', 'dependency_escalation', 'Task dependency is unresolved.'),
  'preflight.attribution': policy('attribution', 'repair_attribution', 'none', 'Commit attribution is invalid.'),
  'preflight.evidence': policy('evidence', 'repair_evidence', 'none', 'Required evidence is invalid.'),
  'preflight.checks': policy('checks', 'repair_check_evidence', 'none', 'Required check evidence is invalid.'),
  'preflight.checks.task_contract': policy('checks', 'repair_required_checks', 'contract_reconciliation', 'Task required-check declaration is invalid.'),
  'preflight.task_policy': policy('task_policy', 'repair_task_policy', 'contract_reconciliation', 'Task policy is invalid.'),
  'preflight.review_checkpoint': policy('review_checkpoint', 'repair_review_checkpoint', 'none', 'Review checkpoint is invalid.'),
  'preflight.revision_resolution': policy('revision_resolution', 'repair_revision_resolution', 'none', 'Review resolution is invalid.'),
  'preflight.review_provenance': policy('review_provenance', 'repair_review_provenance', 'none', 'Review provenance is invalid.'),
  'preflight.other': policy('other', 'repair_preflight_input', 'none', 'Preflight input is invalid.'),
  'pr_body.structural': policy('pr_body', 'repair_pr_body_structure', 'none', 'PR body structure is incomplete or malformed.'),
  'pr_body.input': policy('preparation_input', 'complete_pr_body_input', 'none', 'Serialized evaluation input is incomplete or malformed.'),
  'pr_body.snapshot': policy('snapshot_context', 'regenerate_pr_body_snapshot', 'none', 'Offline PR-body snapshot context is invalid.'),
  'pr_body.deprecation': policy('deprecation', 'migrate_pr_body_command', 'none', 'A deprecated PR-body command form is in use.'),
  'pr_body.local_file': policy('local_file', 'repair_local_pr_body_file', 'none', 'A local PR-body input or output file is unavailable.'),
  'pr_body.input_format': policy('input_format', 'repair_pr_body_input_format', 'none', 'PR-body input format is invalid.'),
  'cli.usage': policy('usage', 'correct_command_usage', 'none', 'Command usage is invalid.'),
  'cli.operational': policy('operational_error', 'repair_command_environment', 'human_authority_review', 'A command dependency or execution environment is unavailable.'),
  'cli.unexpected': policy('operational_error', 'repair_evidence', 'human_authority_review', 'The public command failed unexpectedly.'),
  'review_prepare.workspace': policy('workspace', 'repair_review_workspace', 'none', 'The review workspace does not match the exact review artifact.'),
  'review_prepare.stale_head': policy('stale_head', 'refresh_review_preparation', 'none', 'Review preparation is stale relative to the current PR head.'),
  'review_prepare.packet': policy('review_packet', 'regenerate_review_packet', 'none', 'The review preparation packet is invalid.'),
  'attribution.trailer': policy('attribution', 'repair_attribution_trailer', 'none', 'Commit attribution trailer block is invalid.'),
  'attribution.role': policy('attribution', 'repair_attribution_trailer', 'none', 'The expected commit-attribution role is not a canonical lowercase workflow role.'),
  'ready.preflight': policy('preflight', 'repair_preflight_gate', 'none', 'A preflight component gate failed.'),
  'ready.review_audit': policy('review_audit', 'repair_review_audit', 'none', 'The review-audit component gate failed.'),
  'ready.task_identity': policy('task_identity', 'repair_task_identity', 'none', 'Cross-carrier task identity is invalid.'),
  'ready.cross_gate_identity': policy('cross_gate_identity', 'reconcile_cross_gate_identity', 'none', 'Cross-gate task identity is inconsistent.'),
  'review_audit.task_contract': policy('task_contract', 'repair_task_record', 'contract_reconciliation', 'Task record is malformed for review audit.'),
  'review_audit.failure': policy('review_audit', 'repair_review_audit', 'none', 'Review audit failed.'),
  // Projection reconciliation and parallel-scan provenance reuse the existing
  // repair and escalation kinds. Both report evidence facts; neither introduces
  // a new repair capability that role declarations would have to own.
  'projection.observation.invalid': policy('projection', 'repair_evidence', 'none', 'A backend projection observation is malformed or does not describe a canonical transition-contract fact.'),
  'projection.carrier.not_applicable': policy('projection', 'repair_evidence', 'none', 'The observation claims a carrier the selected backend does not project.'),
  'projection.evidence.superseded': policy('projection', 'repair_evidence', 'none', 'Projection evidence is stale or changed and is superseded rather than current.'),
  'projection.fact.contradiction': policy('projection', 'repair_evidence', 'contract_reconciliation', 'Two current authoritative carriers report contradictory values for one fact.'),
  'projection.authority.untyped': policy('projection', 'repair_evidence', 'none', 'An untyped carrier confers no lifecycle authority and is advisory only.'),
  'projection.state.unexplained': policy('workspace', 'repair_review_workspace', 'contract_reconciliation', 'Observed state is unclassified drift and blocks authority-sensitive conclusions.'),
  // Decomposition and its parallel-scan inventory are Maintainer authoring
  // work: `task prepare-decomposition` produces them and their committed source
  // must carry Maintainer attribution. Routing their repair to Engineer is the
  // field defect - it is what let the field session's Engineer regenerate
  // decomposition and rewrite provenance inside its own run.
  'parallel_scan.inventory.incomplete': policy('parallel_scan', 'regenerate_decomposition', 'contract_reconciliation', 'The bounded work-unit task inventory is incomplete and cannot support a complete ready-set conclusion.'),
  'parallel_scan.record.invalid': policy('parallel_scan', 'regenerate_decomposition', 'none', 'The parallel-scan record is malformed, mis-digested, or does not account for its inventory.'),
  'parallel_scan.evidence.stale': policy('parallel_scan', 'regenerate_decomposition', 'none', 'The parallel-scan observation is outside its declared freshness policy.'),
  'parallel_scan.decomposition.invalid': policy('parallel_scan', 'regenerate_decomposition', 'contract_reconciliation', 'The decomposition source, attribution, or completeness declaration is invalid.'),
  // Canonical handoff recognition. These reuse the existing repair and
  // escalation kinds: the operator- or role-facing repair is always to produce
  // the canonical artifact - a fresh `task prepare-dispatch` packet or a
  // persisted `task verify-return` result - never to relax the boundary.
  'handoff.transition.unsupported': policy('handoff', 'repair_evidence', 'none', 'The requested transition is not a protected lifecycle transition this seam recognizes.'),
  'handoff.expectation.malformed': policy('handoff', 'repair_evidence', 'none', 'The supplied handoff expectation is malformed or does not bind a task and role.'),
  'handoff.evidence.missing': policy('handoff', 'repair_evidence', 'none', 'The canonical prepared dispatch or verified return required by this transition was not supplied.'),
  'handoff.evidence.malformed': policy('handoff', 'repair_evidence', 'none', 'Supplied handoff evidence is malformed or is not the canonical record kind.'),
  'handoff.evidence.stale': policy('handoff', 'repair_evidence', 'none', 'Supplied handoff evidence is outside its freshness policy or no longer matches current state.'),
  'handoff.evidence.replayed': policy('handoff', 'repair_evidence', 'none', 'The prepared dispatch was already consumed; an authoritative role start requires a fresh packet.'),
  'handoff.evidence.mismatched': policy('handoff', 'repair_evidence', 'none', 'Supplied handoff evidence binds a different task, role, packet, artifact, or worktree.'),
  'handoff.evidence.unsupported': policy('handoff', 'repair_evidence', 'none', 'Supplied handoff evidence declares a schema or assurance grade this boundary cannot evaluate.'),
  'handoff.evidence.unauthenticated': policy('handoff', 'repair_evidence', 'human_authority_review', 'Handoff evidence is session-reported or below the required assurance minimum and cannot authorize a protected transition.'),
  'handoff.refresh.plan.malformed': policy('handoff', 'repair_evidence', 'none', 'Handoff evidence refresh plan is malformed or does not match the expected task binding.'),
  'handoff.refresh.plan.unsupported': policy('handoff', 'repair_evidence', 'none', 'Derived-evidence refresh plans apply only to the files backend; the selected backend has no local derived-evidence surface to refresh.'),
});

function policy(category, repairKind, escalationKind, description) {
  return Object.freeze({ category, repairKind, escalationKind, description });
}

export function repairPolicyFor(code) {
  const entry = REPAIR_POLICY[code];
  if (!entry) throw new Error(`diagnostic code lacks repair policy: ${code}`);
  return entry;
}

export function assertDiagnosticPolicy(code) {
  const entry = repairPolicyFor(code);
  if (!entry.description) throw new Error(`diagnostic code lacks renderable description: ${code}`);
  if (!entry.repairKind) throw new Error(`diagnostic code lacks a repair kind: ${code}`);
  if (!entry.escalationKind) throw new Error(`diagnostic code lacks an escalation kind: ${code}`);
  return entry;
}

/** Every repair kind an actionable diagnostic can require. */
export const REPAIR_KINDS = Object.freeze([...new Set(Object.values(REPAIR_POLICY).map(entry => entry.repairKind))]);

/** Every escalation kind an actionable diagnostic can require. */
export const ESCALATION_KINDS = Object.freeze([...new Set(Object.values(REPAIR_POLICY).map(entry => entry.escalationKind))]);

/** Escalation kinds with this prefix resolve to the human authority boundary, never to an agent role. */
export const HUMAN_AUTHORITY_ESCALATION_PREFIX = 'human_authority';

/**
 * Canonical diagnostic fact constructor. Evaluator facts carry level, code,
 * category, repairKind, escalationKind, evidence, a factual message, and
 * domain-specific factual metadata only; routing fields are rejected here
 * and derived later by the presentation layer.
 *
 * @param {{ level?: string, code: string, evidence?: object, message?: string|null, repairHint?: string } & object} fact
 */
export function createDiagnostic({ level = 'error', code, evidence = {}, message = null, ...details } = {}) {
  const entry = assertDiagnosticPolicy(code);
  const protectedFields = ['category', 'repairKind', 'escalationKind', 'owner', 'escalationOwner', 'ownerRouting', 'nextAction', 'firstSafeRepair', 'dependsOn'];
  for (const field of protectedFields) {
    if (Object.hasOwn(details, field)) throw new Error(`diagnostic policy field '${field}' cannot be evaluator-supplied`);
  }
  if (details.diagnosticPrerequisites !== undefined &&
      (!Array.isArray(details.diagnosticPrerequisites) ||
       !details.diagnosticPrerequisites.every(item => typeof item === 'string' && item))) {
    throw new Error('diagnosticPrerequisites must be an array of non-empty strings');
  }
  return {
    ...details,
    level,
    code,
    category: entry.category,
    message: message ?? renderDiagnosticMessage(code, evidence),
    evidence,
    repairKind: entry.repairKind,
    escalationKind: entry.escalationKind,
  };
}

/** Render facts supplied as structured evidence without embedding policy in gates. */
export function renderDiagnosticMessage(code, evidence = {}) {
  const path = Array.isArray(evidence.paths) ? evidence.paths[0] : null;
  switch (code) {
    case 'scope.declaration.duplicate':
      return `duplicate ${evidence.field ?? 'scope'} entry '${path ?? ''}'`;
    case 'scope.declaration.invalid':
      return evidence.reason ?? `'${evidence.field ?? 'scope'}' must be a YAML list of repo-relative paths`;
    case 'scope.existing_path.missing':
      return `literal allowed path '${path ?? ''}' is absent from the base tree`;
    case 'scope.intended_creation.missing':
      return `literal allowed path '${path ?? ''}' is absent from the base tree and is not declared as an intended creation or generated output`;
    case 'scope.intended_creation.uncovered':
      return `intended_creation '${path ?? ''}' is not covered by allowed_paths`;
    case 'scope.intent.invalid':
      return `intended_creation '${path ?? ''}' must be an exact safe repo-relative path`;
    case 'scope.glob.unmatched':
      return `scope glob '${path ?? ''}' matches no base-tree paths and is not creation-capable`;
    case 'scope.deviation.missing':
      return `unexpected file '${path ?? ''}' has no declaration in ## Deviations`;
    case 'scope.deviation.malformed':
      if (Array.isArray(evidence.errors) && evidence.errors.length) return evidence.errors[0];
      if (evidence.kind === 'stale') return `deviation declared for '${path ?? ''}' but the file is not in the current PR`;
      if (evidence.kind === 'in_scope') return `deviation declared for '${path ?? ''}' but the file is already covered by allowed_paths`;
      return repairPolicyFor(code).description;
    case 'generated.path.invalid':
      if (evidence.reason === 'invalid_path') return `generated path '${path ?? ''}' must be an exact repo-relative path`;
      return `generated path '${path ?? ''}' requires generator, source, and verification (parity or regeneration)`;
    case 'readiness.mode.invalid':
      return "mode must be explicitly 'authoring' or 'review'";
    default:
      return repairPolicyFor(code).description;
  }
}

export function preflightDiagnosticCode(category) {
  return `preflight.${String(category ?? 'other')}`;
}

for (const code of Object.keys(REPAIR_POLICY)) assertDiagnosticPolicy(code);
