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
  'evidence.missing': policy('evidence', 'repair_evidence', 'none', 'Required evidence was not supplied.'),
  'evidence.malformed': policy('evidence', 'repair_evidence', 'none', 'Supplied evidence is malformed.'),
  'evidence.stale': policy('evidence', 'repair_evidence', 'none', 'Supplied evidence is stale.'),
  'evidence.negative': policy('evidence', 'repair_evidence', 'none', 'Supplied evidence shows the required condition is false.'),
  'evidence.changed': policy('evidence', 'repair_evidence', 'none', 'Evidence changed after preparation or verification.'),
  'verification.context.missing': policy('evidence', 'repair_evidence', 'none', 'Verification context was not supplied; committed state was not evaluated.'),
  'verification.context.malformed': policy('evidence', 'repair_evidence', 'none', 'Supplied verification context is malformed; committed state was not evaluated.'),
  'worktree.clean_gate.failed': policy('workspace', 'repair_review_workspace', 'none', 'The clean-worktree gate failed.'),
  'state.host_local': policy('workspace', 'repair_review_workspace', 'none', 'Host-local or preexisting state requires classification.'),
  'role_result.schema.invalid': policy('evidence', 'repair_evidence', 'none', 'The role result does not satisfy its required schema.'),
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
  'ready.preflight': policy('preflight', 'repair_preflight_gate', 'none', 'A preflight component gate failed.'),
  'ready.review_audit': policy('review_audit', 'repair_review_audit', 'none', 'The review-audit component gate failed.'),
  'ready.task_identity': policy('task_identity', 'repair_task_identity', 'none', 'Cross-carrier task identity is invalid.'),
  'ready.cross_gate_identity': policy('cross_gate_identity', 'reconcile_cross_gate_identity', 'none', 'Cross-gate task identity is inconsistent.'),
  'review_audit.task_contract': policy('task_contract', 'repair_task_record', 'contract_reconciliation', 'Task record is malformed for review audit.'),
  'review_audit.failure': policy('review_audit', 'repair_review_audit', 'none', 'Review audit failed.'),
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
