import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUMAN_AUTHORITY_BOUNDARY,
  TRANSITION_AUDIT_BUDGET_POLICY,
  TRANSITION_AUTHORITIES,
  TRANSITION_CONTRACT_DEFINITION,
  TRANSITION_CONTRACT_ID,
  TRANSITION_CONTRACT_SCHEMA_VERSION,
  TRANSITION_DISPOSITIONS,
  TRANSITION_EVIDENCE_STATES,
  TRANSITION_FACTS,
  TRANSITION_IDENTITY_CHAIN,
  TRANSITION_LIFECYCLE_CLAIMS,
  TRANSITION_LIVENESS_VOCABULARY,
  TRANSITION_RETURN_SHAPES,
  TRANSITION_STATE_PROVENANCE,
  TRANSITION_TERMINAL_CONTRACT,
  WORKFLOW_ROLE_REGISTRY,
  WORKFLOW_ROLES,
  projectTransitionContract,
  projectTransitionContractSemantics,
  resolveTerminalDecision,
  validateTransitionContractDefinition,
} from '../src/transition-contract.js';
import { TOOLKIT_SOURCE_RELATIVE_PATHS } from '../src/layout.js';
import { OPENCODE_ROLE_NAMES } from '../src/adapters/opencode.js';
import { CLAUDE_CODE_ROLE_NAMES } from '../src/remove.js';
import { HUMAN_AUTHORITY_BOUNDARY as ROLE_CAPABILITY_HUMAN_BOUNDARY } from '../src/role-capabilities.js';
import { WORKFLOW_ROLES as RUNTIME_WORKFLOW_ROLES } from '../src/workflow-vocabulary.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = relativePath => readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
const clone = value => structuredClone(value);

function isDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every(child => isDeepFrozen(child, seen));
}

function normalizedProjection(projection) {
  const normalized = clone(projection);
  normalized.projectionBackend = '<backend>';
  for (const fact of normalized.facts) fact.carrierApplicability = '<backend-carrier-applicability>';
  return normalized;
}

function markdownTableIds(markdown, heading, nextHeading) {
  const start = markdown.indexOf(heading);
  const end = markdown.indexOf(nextHeading, start + heading.length);
  assert.ok(start >= 0 && end > start, `missing methodology table '${heading}'`);
  return markdown.slice(start, end).split('\n')
    .map(line => line.match(/^\| `([^`]+)` \|/)?.[1])
    .filter(Boolean);
}

describe('canonical transition contract', () => {
  it('is one complete self-identifying serializable definition', () => {
    assert.equal(TRANSITION_CONTRACT_ID, 'agenticloop.transition-contract');
    assert.equal(TRANSITION_CONTRACT_SCHEMA_VERSION, 1);
    assert.equal(TRANSITION_CONTRACT_DEFINITION.kind, TRANSITION_CONTRACT_ID);
    assert.deepEqual(TRANSITION_CONTRACT_DEFINITION.supportedBackends, ['files', 'github']);
    assert.doesNotThrow(() => JSON.stringify(TRANSITION_CONTRACT_DEFINITION));
    assert.deepEqual(validateTransitionContractDefinition(), { ok: true, errors: [] });
    for (const section of [
      'envelope', 'evidenceStates', 'dispositions', 'lifecycleClaims', 'facts',
      'identityChain', 'authorityRules', 'capabilityVocabulary', 'returnShapes',
      'terminalContract', 'markdownPolicy', 'auditBudgetPolicy', 'stateProvenance',
      'livenessVocabulary',
    ]) assert.ok(TRANSITION_CONTRACT_DEFINITION[section], section);
  });

  it('owns shared role and human-boundary vocabulary without drift', () => {
    assert.strictEqual(WORKFLOW_ROLES, RUNTIME_WORKFLOW_ROLES);
    assert.strictEqual(WORKFLOW_ROLE_REGISTRY, TRANSITION_CONTRACT_DEFINITION.ownership.workflowRoles);
    assert.deepEqual(WORKFLOW_ROLE_REGISTRY, [
      { roleId: 'orchestrator', defaultLabel: 'Orchestrator', escalationPrecedence: 10 },
      { roleId: 'maintainer', defaultLabel: 'Maintainer', escalationPrecedence: 20 },
      { roleId: 'engineer', defaultLabel: 'Engineer', escalationPrecedence: 30 },
      { roleId: 'auditor', defaultLabel: 'Auditor', escalationPrecedence: 40 },
    ]);
    assert.equal(HUMAN_AUTHORITY_BOUNDARY, ROLE_CAPABILITY_HUMAN_BOUNDARY);
    assert.deepEqual(WORKFLOW_ROLES, ['orchestrator', 'maintainer', 'engineer', 'auditor']);
    assert.deepEqual(OPENCODE_ROLE_NAMES, WORKFLOW_ROLES);
    assert.deepEqual(CLAUDE_CODE_ROLE_NAMES, WORKFLOW_ROLES);
    assert.equal(Object.isFrozen(WORKFLOW_ROLES), true);
    assert.deepEqual(TRANSITION_CONTRACT_DEFINITION.ownership.roleIdentityPolicy, {
      durableIdentity: 'roleId',
      labelUsage: 'display_only',
      semanticDigestExcludedField: 'defaultLabel',
      capabilitySource: 'agents/<roleId>.md frontmatter',
      roleIdRename: 'versioned_alias_or_explicit_migration_required',
    });
    assert.equal(HUMAN_AUTHORITY_BOUNDARY, 'human_authority');
  });

  it('treats labels as presentation-only while preserving every durable role fact', () => {
    const candidate = clone(TRANSITION_CONTRACT_DEFINITION);
    candidate.ownership.workflowRoles[1].defaultLabel = 'Release Steward';
    assert.deepEqual(validateTransitionContractDefinition(candidate), { ok: true, errors: [] });
    assert.deepEqual(
      candidate.ownership.workflowRoles.map(({ roleId, escalationPrecedence }) => ({ roleId, escalationPrecedence })),
      WORKFLOW_ROLE_REGISTRY.map(({ roleId, escalationPrecedence }) => ({ roleId, escalationPrecedence }))
    );
    assert.deepEqual(candidate.lifecycleClaims, TRANSITION_CONTRACT_DEFINITION.lifecycleClaims);
    assert.deepEqual(candidate.facts, TRANSITION_CONTRACT_DEFINITION.facts);
    assert.deepEqual(candidate.identityChain, TRANSITION_CONTRACT_DEFINITION.identityChain);
    assert.deepEqual(candidate.authorityRules, TRANSITION_CONTRACT_DEFINITION.authorityRules);
    for (const backend of ['files', 'github']) {
      const canonicalDisplay = projectTransitionContract(backend);
      const renamedDisplay = projectTransitionContract(backend, candidate);
      assert.notDeepEqual(renamedDisplay, canonicalDisplay);
      assert.equal(renamedDisplay.ownership.workflowRoles[1].defaultLabel, 'Release Steward');

      const canonicalSemantics = projectTransitionContractSemantics(backend);
      const renamedSemantics = projectTransitionContractSemantics(backend, candidate);
      assert.deepEqual(renamedSemantics, canonicalSemantics);
      assert.equal(
        renamedSemantics.ownership.workflowRoles.some(role => Object.hasOwn(role, 'defaultLabel')),
        false
      );
    }
  });

  it('locks canonical claim, fact, boundary, action, and terminal inventories independently', () => {
    assert.deepEqual(TRANSITION_LIFECYCLE_CLAIMS.map(item => item.claimId), [
      'implementation_blocked', 'implementation_ready_for_review', 'review_changes_requested',
      'review_accepted', 'closeout_complete',
    ]);
    assert.deepEqual(TRANSITION_FACTS.map(item => item.factId), [
      'contract_readiness', 'runtime_blocked_state', 'task_lifecycle_status', 'labels',
      'comments', 'review_readiness', 'review_verdict', 'audit_state', 'terminal_closeout',
    ]);
    assert.deepEqual(TRANSITION_IDENTITY_CHAIN.map(item => item.boundaryId), [
      'operator_request', 'activation_input', 'authored_task', 'dispatch', 'role_return',
      'review', 'audit', 'terminal_closeout',
    ]);
    assert.deepEqual(TRANSITION_AUTHORITIES.map(item => item.actionId), [
      'request_and_activation_identity', 'blocked_result_resumption', 'exceptional_verification',
      'destructive_or_scope_changing_recovery', 'terminal_closeout',
    ]);
    assert.deepEqual(TRANSITION_TERMINAL_CONTRACT.decisionTable.map(item => item.caseId), [
      'configured_group_audit_enabled', 'configured_group_audit_disabled',
      'explicit_task_set_audit_enabled', 'explicit_task_set_audit_disabled',
      'no_scope_audit_enabled', 'no_scope_audit_disabled',
      'indeterminate_audit_enabled', 'indeterminate_audit_disabled',
    ]);
  });

  it('deeply freezes the definition, aliases, nested carriers, and projections', () => {
    assert.equal(isDeepFrozen(TRANSITION_CONTRACT_DEFINITION), true);
    for (const value of [
      TRANSITION_FACTS,
      TRANSITION_FACTS[0].carriers.files,
      TRANSITION_AUTHORITIES,
      TRANSITION_IDENTITY_CHAIN,
      TRANSITION_TERMINAL_CONTRACT,
      TRANSITION_AUDIT_BUDGET_POLICY,
      WORKFLOW_ROLE_REGISTRY,
      WORKFLOW_ROLE_REGISTRY[0],
      WORKFLOW_ROLES,
      projectTransitionContract('files'),
      projectTransitionContract('github'),
    ]) assert.equal(isDeepFrozen(value), true);

    const original = TRANSITION_FACTS[0].canonicalSource;
    assert.throws(() => { TRANSITION_FACTS[0].canonicalSource = 'changed'; }, TypeError);
    assert.throws(() => { TRANSITION_FACTS[0].carriers.files.carrier = 'changed'; }, TypeError);
    assert.throws(() => { TRANSITION_TERMINAL_CONTRACT.owner.ownerId = 'orchestrator'; }, TypeError);
    assert.throws(() => { TRANSITION_CONTRACT_DEFINITION.ownership.workflowRoles.push('reviewer'); }, TypeError);
    assert.throws(() => { WORKFLOW_ROLE_REGISTRY[0].defaultLabel = 'Coordinator'; }, TypeError);
    assert.equal(TRANSITION_FACTS[0].canonicalSource, original);
  });

  it('defines a self-identifying envelope with exact digest and result identities', () => {
    const envelope = TRANSITION_CONTRACT_DEFINITION.envelope;
    for (const field of [
      'kind', 'schemaVersion', 'transition.id', 'transition.expectedPredecessor',
      'artifact.kind', 'artifact.id', 'digest.algorithm', 'digest.format',
      'digest.canonicalization', 'digest.value', 'provenance.state',
      'provenance.producer', 'freshness.observedAt', 'freshness.invalidatedBy',
      'validation.resultKind', 'validation.evidenceState', 'disposition',
    ]) assert.ok(envelope.requiredFields.includes(field), field);
    assert.equal(envelope.constants['digest.algorithm'], 'sha256');
    assert.equal(envelope.constants['digest.canonicalization'], 'agenticloop.transition-projection.v1');
    assert.equal(envelope.constants['validation.resultKind'], 'agenticloop.validation-result');
  });

  it('uses separate required fields and constants for return shapes', () => {
    assert.ok(TRANSITION_RETURN_SHAPES.blocked.requiredFields.includes('disposition'));
    assert.equal(TRANSITION_RETURN_SHAPES.blocked.constants.disposition, 'blocked');
    assert.ok(!TRANSITION_RETURN_SHAPES.blocked.requiredFields.includes('disposition:blocked'));
    assert.equal(TRANSITION_RETURN_SHAPES.exceptionalVerification.constants.kind, 'agenticloop.exceptional-verification');
  });

  it('maps every lifecycle claim to typed exact evidence and freshness', () => {
    assert.deepEqual(TRANSITION_LIFECYCLE_CLAIMS.map(item => item.claimId), [
      'implementation_blocked',
      'implementation_ready_for_review',
      'review_changes_requested',
      'review_accepted',
      'closeout_complete',
    ]);
    for (const claim of TRANSITION_LIFECYCLE_CLAIMS) {
      assert.ok(TRANSITION_CONTRACT_DEFINITION.evidenceTypes.includes(claim.evidenceType));
      assert.ok(claim.producer.ownerKind && claim.producer.ownerId);
      assert.ok(claim.authority.ownerKind && claim.authority.ownerId);
      assert.ok(claim.artifactBinding && claim.invalidatedBy);
      assert.ok(TRANSITION_DISPOSITIONS.includes(claim.absentOrInvalidDisposition));
    }
    const ready = TRANSITION_LIFECYCLE_CLAIMS.find(item => item.claimId === 'implementation_ready_for_review');
    assert.deepEqual(ready.workOwner, { ownerKind: 'workflow_role', ownerId: 'engineer' });
    assert.deepEqual(ready.producer, { ownerKind: 'component', ownerId: 'review_preparation_gate' });
    assert.deepEqual(ready.authority, { ownerKind: 'component', ownerId: 'review_preparation_gate' });
  });

  it('keeps source, producer, persister, and typed carrier applicability distinct', () => {
    assert.deepEqual(TRANSITION_FACTS.map(item => item.factId), [
      'contract_readiness', 'runtime_blocked_state', 'task_lifecycle_status',
      'labels', 'comments', 'review_readiness', 'review_verdict', 'audit_state',
      'terminal_closeout',
    ]);
    const audit = TRANSITION_FACTS.find(item => item.factId === 'audit_state');
    assert.deepEqual(audit.producer, { ownerKind: 'workflow_role', ownerId: 'auditor' });
    assert.deepEqual(audit.persister, { ownerKind: 'component', ownerId: 'audit_cli' });
    const labels = TRANSITION_FACTS.find(item => item.factId === 'labels');
    assert.deepEqual(labels.carriers.files, { applicable: false, carrier: null });
  });

  it('projects every shared section with backend identity and selected carrier applicability', () => {
    const files = projectTransitionContract('files');
    const github = projectTransitionContract('github');
    const expectedKeys = [...Object.keys(TRANSITION_CONTRACT_DEFINITION), 'projectionBackend'].sort();
    assert.deepEqual(Object.keys(files).sort(), expectedKeys);
    assert.deepEqual(Object.keys(github).sort(), expectedKeys);
    assert.deepEqual(normalizedProjection(files), normalizedProjection(github));
    assert.equal(files.projectionBackend, 'files');
    assert.equal(github.projectionBackend, 'github');
    assert.deepEqual(files.facts.find(item => item.factId === 'labels').carrierApplicability, { applicable: false, carrier: null });
    assert.deepEqual(github.facts.find(item => item.factId === 'labels').carrierApplicability, { applicable: true, carrier: 'issue labels' });
  });

  it('fails unsupported projections through a stable typed error', () => {
    assert.throws(
      () => projectTransitionContract('other'),
      error => error.name === 'TransitionContractBackendError' &&
        error.code === 'transition_contract.backend_unsupported' && error.backend === 'other'
    );
  });

  it('resolves every evidence-derived terminal scope and audit mode independently', () => {
    const rows = Object.fromEntries(TRANSITION_TERMINAL_CONTRACT.decisionTable.map(row => [row.caseId, row]));
    for (const id of ['configured_group_audit_enabled', 'configured_group_audit_disabled', 'explicit_task_set_audit_enabled', 'explicit_task_set_audit_disabled']) {
      assert.equal(rows[id].scopeEstablished, true);
      assert.equal(rows[id].genericTerminalAllowed, false);
      assert.equal(rows[id].terminalAction, 'closeout_owned_accepted_to_closed');
    }
    assert.equal(rows.configured_group_audit_enabled.auditCertificateRequired, true);
    assert.equal(rows.configured_group_audit_disabled.auditCertificateRequired, false);
    assert.equal(rows.explicit_task_set_audit_enabled.auditCertificateRequired, true);
    assert.equal(rows.explicit_task_set_audit_disabled.auditCertificateRequired, false);
    assert.equal(rows.no_scope_audit_enabled.genericTerminalAllowed, true);
    assert.equal(rows.no_scope_audit_disabled.genericTerminalAllowed, true);
    assert.equal(rows.indeterminate_audit_enabled.genericTerminalAllowed, false);
    assert.equal(rows.indeterminate_audit_disabled.genericTerminalAllowed, false);
    for (const id of ['indeterminate_audit_enabled', 'indeterminate_audit_disabled']) {
      assert.equal(rows[id].disposition, 'blocked');
      assert.equal(rows[id].terminalAction, null);
      assert.equal(rows[id].resumeCondition, 'repair_and_rederive_scope');
    }
    for (const row of TRANSITION_TERMINAL_CONTRACT.decisionTable) {
      assert.strictEqual(resolveTerminalDecision(row), row);
    }
    assert.throws(() => resolveTerminalDecision({ scopeKind: 'none', auditMode: 'unknown' }), {
      code: 'transition_contract.terminal_scope_invalid',
    });
    assert.deepEqual(TRANSITION_TERMINAL_CONTRACT.owner, { ownerKind: 'workflow_role', ownerId: 'maintainer' });
    assert.equal(TRANSITION_TERMINAL_CONTRACT.capability, 'task_terminal_closeout');
    assert.match(TRANSITION_TERMINAL_CONTRACT.currentRecognition, /does not execute/);
  });

  it('declares audit recovery but marks it operationally unavailable', () => {
    const recovery = TRANSITION_AUDIT_BUDGET_POLICY.productInvalidationRecovery;
    assert.equal(recovery.kind, 'product_invalidation_recovery');
    assert.equal(recovery.limit, 1);
    assert.equal(recovery.availability, 'declared_not_operational');
    assert.equal(recovery.enforcement, 'unavailable');
    assert.deepEqual(recovery.requiredEvidence, [
      'typed_cause', 'invalidation_reference', 'affected_prior_run', 'maintainer_recorded_cause',
    ]);
    const skill = read('skills/work-unit-audit/SKILL.md');
    assert.match(skill, /every\s+completed substantive report consumes `audit_budget`/);
    assert.match(skill, /must not claim or attempt a non-consuming recovery/);
    assert.match(skill, /human-approved\s+override/);
  });

  it('keeps accepted lease and managed-join vocabulary truthful', () => {
    assert.match(TRANSITION_LIVENESS_VOCABULARY.lease, /accepted external term during migration/);
    assert.match(TRANSITION_LIVENESS_VOCABULARY.lease, /delegation_liveness_window/);
    assert.match(TRANSITION_LIVENESS_VOCABULARY.managedJoin, /managed_join: existing bounded relation/);
    assert.doesNotMatch(TRANSITION_LIVENESS_VOCABULARY.managedJoin, /managed_join_plan:/);
  });

  it('rejects malformed structural and cross-reference candidates without global mutation', () => {
    const fixtures = [
      ['identity', candidate => { candidate.contractId = 'wrong'; }],
      ['schema', candidate => { candidate.schemaVersion = 0; }],
      ['backends', candidate => { candidate.supportedBackends.pop(); }],
      ['ownership', candidate => { candidate.ownership.workflowRoles[0] = 'wrong'; }],
      ['empty role registry', candidate => { candidate.ownership.workflowRoles = []; }],
      ['unknown role property', candidate => { candidate.ownership.workflowRoles[0].alias = 'coord'; }],
      ['missing role field', candidate => { delete candidate.ownership.workflowRoles[0].defaultLabel; }],
      ['duplicate role ID', candidate => { candidate.ownership.workflowRoles[1].roleId = 'orchestrator'; }],
      ['malformed role ID', candidate => { candidate.ownership.workflowRoles[0].roleId = 'Orchestrator'; }],
      ['blank label', candidate => { candidate.ownership.workflowRoles[0].defaultLabel = '  '; }],
      ['non-string label', candidate => { candidate.ownership.workflowRoles[0].defaultLabel = 1; }],
      ['duplicate precedence', candidate => { candidate.ownership.workflowRoles[1].escalationPrecedence = 10; }],
      ['missing precedence', candidate => { delete candidate.ownership.workflowRoles[0].escalationPrecedence; }],
      ['non-positive precedence', candidate => { candidate.ownership.workflowRoles[0].escalationPrecedence = 0; }],
      ['non-integer precedence', candidate => { candidate.ownership.workflowRoles[0].escalationPrecedence = 1.5; }],
      ['unsafe precedence', candidate => { candidate.ownership.workflowRoles[0].escalationPrecedence = Number.MAX_SAFE_INTEGER + 1; }],
      ['malformed identity policy', candidate => { candidate.ownership.roleIdentityPolicy.labelUsage = 'authority'; }],
      ['unknown identity policy property', candidate => { candidate.ownership.roleIdentityPolicy.locale = 'en'; }],
      ['label used as owner ID', candidate => { candidate.facts[0].producer.ownerId = 'Maintainer'; }],
      ['dangling role owner', candidate => { candidate.identityChain[2].owner.ownerId = 'reviewer'; }],
      ['unknown owner kind', candidate => { candidate.ownership.ownerKinds.push('unknown'); }],
      ['envelope', candidate => { candidate.envelope.requiredFields.pop(); }],
      ['evidence states', candidate => { candidate.evidenceStates.push('missing'); }],
      ['dispositions', candidate => { candidate.dispositions.pop(); }],
      ['lifecycle claims', candidate => { candidate.lifecycleClaims[0].evidenceType = 'unknown'; }],
      ['facts', candidate => { candidate.facts[0].producer.ownerId = 'unknown'; }],
      ['carriers', candidate => { candidate.facts[3].carriers.files.carrier = 'prose'; }],
      ['unknown backend carrier', candidate => { candidate.facts[0].carriers.other = { applicable: true, carrier: 'unknown' }; }],
      ['identity chain', candidate => { candidate.identityChain.pop(); }],
      ['authority', candidate => { candidate.authorityRules[0].refusalDisposition = 'unknown'; }],
      ['capabilities', candidate => { candidate.capabilityVocabulary.enforcementStates.pop(); }],
      ['degraded report', candidate => { candidate.capabilityVocabulary.degradedReport.requiredFields = []; }],
      ['unknown envelope constant', candidate => { candidate.envelope.constants.disposition = 'proceed'; }],
      ['returns', candidate => { delete candidate.returnShapes.blocked.constants.disposition; }],
      ['unknown blocked-return constant', candidate => { candidate.returnShapes.blocked.constants.returnId = 'fixed'; }],
      ['blocked resume preconditions', candidate => { candidate.returnShapes.blocked.requiredFields.pop(); }],
      ['terminal', candidate => { candidate.terminalContract.decisionTable.pop(); }],
      ['terminal ordered steps', candidate => { candidate.terminalContract.orderedSteps = []; }],
      ['terminal step order', candidate => { candidate.terminalContract.orderedSteps.reverse(); }],
      ['terminal contradiction', candidate => { candidate.terminalContract.decisionTable[0].auditCertificateRequired = false; }],
      ['terminal case identity', candidate => {
        const first = candidate.terminalContract.decisionTable[0].caseId;
        candidate.terminalContract.decisionTable[0].caseId = candidate.terminalContract.decisionTable[1].caseId;
        candidate.terminalContract.decisionTable[1].caseId = first;
      }],
      ['indeterminate fail closed', candidate => { candidate.terminalContract.decisionTable[6].genericTerminalAllowed = true; }],
      ['indeterminate terminal action', candidate => { candidate.terminalContract.decisionTable[6].terminalAction = 'closeout_owned_accepted_to_closed'; }],
      ['markdown', candidate => { candidate.markdownPolicy.preservation = ''; }],
      ['audit recovery', candidate => { candidate.auditBudgetPolicy.productInvalidationRecovery.availability = 'operational'; }],
      ['audit recovery current behavior', candidate => { candidate.auditBudgetPolicy.productInvalidationRecovery.currentBehavior = ''; }],
      ['unknown closed property', candidate => { candidate.terminalContract.unrecognized = true; }],
      ['provenance', candidate => { candidate.stateProvenance.pop(); }],
      ['liveness', candidate => { delete candidate.livenessVocabulary.rollback; }],
    ];
    for (const [name, mutate] of fixtures) {
      const candidate = clone(TRANSITION_CONTRACT_DEFINITION);
      mutate(candidate);
      const result = validateTransitionContractDefinition(candidate);
      assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`);
      assert.ok(result.errors.length > 0, name);
    }
    assert.deepEqual(validateTransitionContractDefinition(), { ok: true, errors: [] });
  });

  it('rejects ownership, authority, order, disposition, and recovery-policy drift', () => {
    const fixtures = [
      ['terminal owner', candidate => {
        candidate.terminalContract.owner.ownerId = 'engineer';
      }],
      ['terminal authority and action', candidate => {
        const rule = candidate.authorityRules.find(item => item.actionId === 'terminal_closeout');
        rule.authority.ownerId = 'engineer';
        rule.requiredAction = 'generic_accepted_to_closed';
      }],
      ['closeout authority', candidate => {
        candidate.lifecycleClaims.find(item => item.claimId === 'closeout_complete').authority.ownerId = 'auditor';
      }],
      ['audit producer', candidate => {
        candidate.facts.find(item => item.factId === 'audit_state').producer.ownerId = 'maintainer';
      }],
      ['blocked-result resumption authority', candidate => {
        const authority = candidate.authorityRules
          .find(item => item.actionId === 'blocked_result_resumption').authority;
        authority.ownerKind = 'workflow_role';
        authority.ownerId = 'orchestrator';
      }],
      ['destructive recovery authority', candidate => {
        const authority = candidate.authorityRules
          .find(item => item.actionId === 'destructive_or_scope_changing_recovery').authority;
        authority.ownerKind = 'workflow_role';
        authority.ownerId = 'orchestrator';
      }],
      ['role-return reconstruction policy', candidate => {
        candidate.identityChain.find(item => item.boundaryId === 'role_return').absentOrInvalid =
          'orchestrator may reconstruct it';
      }],
      ['identity-chain order', candidate => {
        candidate.identityChain.reverse();
      }],
      ['activation dispositions', candidate => {
        candidate.identityChain.find(item => item.boundaryId === 'activation_input')
          .dispositions.push('needs_context');
      }],
    ];

    for (const [name, mutate] of fixtures) {
      const candidate = clone(TRANSITION_CONTRACT_DEFINITION);
      mutate(candidate);
      const result = validateTransitionContractDefinition(candidate);
      assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`);
      assert.ok(result.errors.length > 0, name);
    }
  });
});

describe('installed and documented contract surface', () => {
  it('keeps the executable module package-internal rather than target-installed', () => {
    assert.equal(TOOLKIT_SOURCE_RELATIVE_PATHS.includes('agenticloop/src/transition-contract.js'), false);
    const manifest = JSON.parse(read('manifest.json'));
    assert.equal(manifest.toolkitOwned.sourcePaths.includes('agenticloop/src/transition-contract.js'), false);
    assert.ok(existsSync(join(REPO_ROOT, 'src', 'transition-contract.js')));
  });

  it('keeps methodology inventories in exhaustive parity with the module', () => {
    const methodology = read('AGENTIC_LOOP.md');
    const shared = methodology.slice(
      methodology.indexOf('## Shared Transition Contract'),
      methodology.indexOf('## Activation Boundary')
    );
    assert.deepEqual(
      markdownTableIds(shared, '### Identity chain', '### Lifecycle and source of truth'),
      TRANSITION_IDENTITY_CHAIN.map(item => item.boundaryId)
    );
    assert.deepEqual(
      markdownTableIds(shared, '#### Lifecycle claims', '#### Source-of-truth facts'),
      TRANSITION_LIFECYCLE_CLAIMS.map(item => item.claimId)
    );
    assert.deepEqual(
      markdownTableIds(shared, '#### Source-of-truth facts', '### Authority boundaries'),
      TRANSITION_FACTS.map(item => item.factId)
    );
    assert.deepEqual(
      markdownTableIds(shared, '#### Authority actions', '### Terminal and Markdown rules'),
      TRANSITION_AUTHORITIES.map(item => item.actionId)
    );
    assert.deepEqual(
      markdownTableIds(shared, '#### Terminal variants', 'The canonical ordering'),
      TRANSITION_TERMINAL_CONTRACT.decisionTable.map(item => item.caseId)
    );
    for (const value of [
      ...TRANSITION_EVIDENCE_STATES,
      ...TRANSITION_DISPOSITIONS,
      ...TRANSITION_STATE_PROVENANCE,
      TRANSITION_RETURN_SHAPES.blocked.constants.kind,
      TRANSITION_RETURN_SHAPES.exceptionalVerification.constants.kind,
      ...Object.keys(TRANSITION_LIVENESS_VOCABULARY),
    ]) assert.ok(shared.includes(`\`${value}\``), `methodology missing '${value}'`);
    for (const { roleId, defaultLabel, escalationPrecedence } of WORKFLOW_ROLE_REGISTRY) {
      assert.ok(
        shared.includes(`| \`${roleId}\` | \`${defaultLabel}\` | \`${escalationPrecedence}\` |`),
        `methodology missing registry row '${roleId}'`
      );
    }
    assert.match(shared, /Lower values take priority; ties are invalid\./);
    assert.ok(shared.includes('| `semanticDigestExcludedField` | `defaultLabel` |'));
    for (const value of Object.values(TRANSITION_CONTRACT_DEFINITION.ownership.roleIdentityPolicy)) {
      assert.ok(shared.includes(`\`${value}\``), `methodology missing role identity policy '${value}'`);
    }
  });

  it('keeps config keys and canonical agent identities in exact registry parity', () => {
    const config = JSON.parse(read('config.json'));
    assert.deepEqual(Object.keys(config.roles), WORKFLOW_ROLES);
    assert.equal(JSON.stringify(config.roles).includes('defaultLabel'), false);
    for (const roleId of WORKFLOW_ROLES) {
      assert.equal(config.roles[roleId].sourceFile, `agenticloop/agents/${roleId}.md`);
      assert.match(read(`agents/${roleId}.md`), new RegExp(`^name: ${roleId}$`, 'm'));
    }
  });

  it('keeps role definitions free of the complete contract payload', () => {
    for (const role of WORKFLOW_ROLES) {
      const body = read(`agents/${role}.md`);
      assert.doesNotMatch(body, /^## Shared Transition Contract$/m);
      assert.ok(!body.includes('agenticloop.transition-projection.v1'));
      assert.ok(!body.includes('configured_group_audit_enabled'));
    }
  });
});
