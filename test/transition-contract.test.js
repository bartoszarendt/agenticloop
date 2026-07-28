import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TRANSITION_AUDIT_BUDGET_POLICY,
  TRANSITION_AUTHORITIES,
  TRANSITION_CAPABILITY_ENFORCEMENT,
  TRANSITION_CONTRACT_ID,
  TRANSITION_CONTRACT_SCHEMA_VERSION,
  TRANSITION_DEGRADED_ENFORCEMENT_REPORT,
  TRANSITION_ENVELOPE_FIELDS,
  TRANSITION_EVIDENCE_STATES,
  TRANSITION_FACTS,
  TRANSITION_IDENTITY_CHAIN,
  TRANSITION_LIVENESS_VOCABULARY,
  TRANSITION_MARKDOWN_POLICY,
  TRANSITION_TERMINAL_CONTRACT,
  projectTransitionContract,
  validateTransitionContractDefinition,
} from '../src/transition-contract.js';

const read = relativePath => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf-8');

function fact(name) {
  const result = TRANSITION_FACTS.find(item => item.fact === name);
  assert.ok(result, `expected transition fact '${name}'`);
  return result;
}

describe('shared transition contract', () => {
  it('is a structurally complete versioned contract', () => {
    assert.equal(TRANSITION_CONTRACT_ID, 'agenticloop.transition-contract');
    assert.equal(TRANSITION_CONTRACT_SCHEMA_VERSION, 1);
    assert.deepEqual(TRANSITION_ENVELOPE_FIELDS, [
      'transition', 'artifact', 'digest', 'provenance', 'freshness', 'validation', 'disposition',
    ]);
    assert.deepEqual(validateTransitionContractDefinition(), { ok: true, errors: [] });
  });

  it('projects one contract to both files and GitHub without changing fact ownership', () => {
    const files = projectTransitionContract('files');
    const github = projectTransitionContract('github');

    assert.equal(files.contractId, github.contractId);
    assert.equal(files.schemaVersion, github.schemaVersion);
    assert.deepEqual(files.envelopeFields, github.envelopeFields);
    assert.deepEqual(files.evidenceStates, github.evidenceStates);
    assert.deepEqual(files.dispositions, github.dispositions);
    assert.deepEqual(files.capabilityEnforcement, github.capabilityEnforcement);
    assert.deepEqual(
      files.facts.map(({ carrier, ...fact }) => fact),
      github.facts.map(({ carrier, ...fact }) => fact)
    );
    assert.equal(files.facts.find(item => item.fact === 'labels').carrier, 'not applicable');
    assert.equal(github.facts.find(item => item.fact === 'labels').carrier, 'issue labels');

    assert.match(read('backends/files.md'), /backend-neutral `agenticloop\.transition-contract`/);
    assert.match(read('backends/github.md'), /backend-neutral `agenticloop\.transition-contract`/);
  });

  it('assigns an explicit canonical owner to every status-like fact', () => {
    for (const name of [
      'contract_readiness',
      'runtime_blocked_state',
      'task_lifecycle_status',
      'labels',
      'comments',
      'review_readiness',
      'review_verdict',
      'audit_state',
      'terminal_closeout',
    ]) {
      const item = fact(name);
      assert.ok(item.canonicalSource);
      assert.ok(item.owner);
      assert.ok(item.freshness);
      assert.ok(item.authority);
    }
    assert.equal(fact('runtime_blocked_state').authority, 'authoritative_for_resumption_only');
    assert.equal(fact('labels').authority, 'authoritative_for_label_presence_only');
    assert.equal(fact('comments').authority, 'authoritative_only_for_its_typed_record');
  });

  it('keeps the identity chain rooted in operator input and complete through closeout', () => {
    const boundaries = TRANSITION_IDENTITY_CHAIN.map(item => item.boundary);
    assert.deepEqual(boundaries, [
      'operator_request',
      'activation_input',
      'authored_task',
      'dispatch',
      'role_return',
      'review',
      'audit',
      'terminal_closeout',
    ]);
    assert.match(TRANSITION_IDENTITY_CHAIN[0].requiredEvidence, /exact authorized UTF-8 request/);
    assert.match(TRANSITION_IDENTITY_CHAIN[1].absentOrInvalid, /model restatement is advisory/);
    for (const boundary of TRANSITION_IDENTITY_CHAIN) {
      assert.ok(boundary.identity);
      assert.ok(boundary.owner);
      assert.ok(boundary.requiredEvidence);
      assert.ok(boundary.freshness);
      assert.ok(boundary.absentOrInvalid);
      assert.ok(boundary.dispositions.length > 0);
    }
  });

  it('keeps missing evidence distinct from valid negative evidence', () => {
    assert.ok(TRANSITION_EVIDENCE_STATES.includes('missing'));
    assert.ok(TRANSITION_EVIDENCE_STATES.includes('negative'));
    assert.notEqual(
      TRANSITION_EVIDENCE_STATES.indexOf('missing'),
      TRANSITION_EVIDENCE_STATES.indexOf('negative')
    );
    assert.match(read('AGENTIC_LOOP.md'), /`missing` means no\s+adequate input was supplied;[\s\S]*`negative` means supplied, valid evidence proves/);
  });

  it('represents both enabled and disabled terminal contracts without conflating their authority', () => {
    assert.deepEqual(TRANSITION_TERMINAL_CONTRACT.orderedSteps, [
      'review_accepted',
      'integrated_or_frozen_candidate',
      'current_audit_gate_when_enabled',
      'closeout_prepare',
      'closeout_record',
      'closeout_owned_accepted_to_closed',
    ]);
    assert.match(TRANSITION_TERMINAL_CONTRACT.enabledAuditOrCloseout, /only maintainer_closeout/);
    assert.match(TRANSITION_TERMINAL_CONTRACT.disabledAuditAndCloseout, /generic accepted_to_closed transition remains valid/);
    assert.match(TRANSITION_TERMINAL_CONTRACT.disabledAuditAndCloseout, /outside an enabled audit or closeout scope/);
    assert.match(TRANSITION_TERMINAL_CONTRACT.staleMarker, /superseding marker/);
  });

  it('makes Markdown cardinality, preservation, idempotence, and migration explicit', () => {
    assert.match(TRANSITION_MARKDOWN_POLICY.currentSchema, /exactly one canonical H1/);
    assert.match(TRANSITION_MARKDOWN_POLICY.preservation, /byte-for-byte/);
    assert.match(TRANSITION_MARKDOWN_POLICY.idempotence, /byte-identical/);
    assert.match(TRANSITION_MARKDOWN_POLICY.legacyMigration, /explicit migration/);
  });

  it('bounds audit-budget recovery and distinguishes rejected reports from consumed runs', () => {
    assert.equal(TRANSITION_AUDIT_BUDGET_POLICY.productInvalidationRecovery.kind, 'product_invalidation_recovery');
    assert.equal(TRANSITION_AUDIT_BUDGET_POLICY.productInvalidationRecovery.limit, 1);
    assert.match(TRANSITION_AUDIT_BUDGET_POLICY.noConsumption, /rejected or malformed report/);
    assert.match(TRANSITION_AUDIT_BUDGET_POLICY.productInvalidationRecovery.refusal, /second recovery attempt/);
    assert.match(read('skills/work-unit-audit/SKILL.md'), /One `product_invalidation_recovery` allowance exists per audit record/);
  });

  it('requires the correct authority to resume blocked work or make exceptional recovery', () => {
    const blocked = TRANSITION_AUTHORITIES.find(item => item.action === 'blocked_result_resumption');
    const destructive = TRANSITION_AUTHORITIES.find(item => item.action === 'destructive_or_scope_changing_recovery');
    const exceptional = TRANSITION_AUTHORITIES.find(item => item.action === 'exceptional_verification');
    assert.equal(blocked.authority, 'producing_role_or_explicitly_redelegated_owner');
    assert.equal(destructive.authority, 'human_authority');
    assert.equal(exceptional.authority, 'named_disposition_owner');
    assert.match(blocked.refusal, /nontransferable/);
  });

  it('defines degraded capability reporting and narrow liveness vocabulary without new authority', () => {
    assert.deepEqual(TRANSITION_CAPABILITY_ENFORCEMENT, ['enforced', 'advisory', 'unavailable']);
    assert.deepEqual(TRANSITION_DEGRADED_ENFORCEMENT_REPORT, [
      'host', 'role', 'capability', 'enforcement', 'reason', 'detection_boundary',
    ]);
    assert.match(TRANSITION_LIVENESS_VOCABULARY.delegationLiveness, /grants no mutation authority/);
    assert.match(TRANSITION_LIVENESS_VOCABULARY.cancellation, /never transfers ownership/);
    assert.match(TRANSITION_LIVENESS_VOCABULARY.managedJoin, /not a lease or lock/);
    assert.match(TRANSITION_LIVENESS_VOCABULARY.reviewNoMutation, /not a lease or ownership claim/);
    assert.match(TRANSITION_LIVENESS_VOCABULARY.rollback, /never overwrites changed state/);
  });

  it('keeps the whole contract out of role definitions', () => {
    const methodology = read('AGENTIC_LOOP.md');
    assert.match(methodology, /^## Shared Transition Contract$/m);
    for (const role of ['orchestrator', 'maintainer', 'engineer', 'auditor']) {
      const body = read(`agents/${role}.md`);
      assert.doesNotMatch(body, /^## Shared Transition Contract$/m, `${role} must not duplicate the shared contract`);
      assert.ok(!body.includes('product_invalidation_recovery'), `${role} must not duplicate audit budget policy`);
      assert.ok(!body.includes('agenticloop.exceptional-verification'), `${role} must not duplicate role-return schema`);
    }
  });
});
