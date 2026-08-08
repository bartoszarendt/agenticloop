import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PROJECTION_FACT_IDS,
  PROJECTION_FACT_RELATIONS,
  PROJECTION_OBSERVATION_KIND,
  PROJECTION_OBSERVATION_SCHEMA_VERSION,
  PROJECTION_RECONCILIATION_KIND,
  PROJECTION_RECONCILIATION_SCHEMA_VERSION,
  createProjectionObservation,
  reconcileProjections,
  requiredProjectionFactIds,
  validateProjectionObservationRecord,
} from '../src/projection-reconciliation.js';
import { TRANSITION_FACTS } from '../src/transition-contract.js';

const SOURCE = fileURLToPath(new URL('../src/projection-reconciliation.js', import.meta.url));
const OBSERVED_AT = '2026-08-07T10:00:00.000Z';

function observation(patch = {}) {
  return createProjectionObservation({
    backend: 'github',
    observedAt: OBSERVED_AT,
    invalidatedBy: ['task_record_digest'],
    stateProvenance: 'workflow_state',
    ...patch,
  });
}

function readiness(patch = {}) {
  return observation({
    factId: 'contract_readiness',
    carrier: { applicability: 'applicable', identity: 'task-contract-comment:11' },
    value: { readiness: 'agent-ready', contractDigest: `sha256:v1:${'a'.repeat(64)}` },
    authority: { producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' }, persister: { ownerKind: 'component', ownerId: 'task_contract_store' }, typedRecord: true, artifactBinding: 'T-001' },
    evidenceState: 'current',
    ...patch,
  });
}

function lifecycle(patch = {}) {
  return observation({
    factId: 'task_lifecycle_status',
    carrier: { applicability: 'applicable', identity: 'issue-body:11' },
    value: { status: 'in-progress', terminal: false },
    authority: { producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' }, persister: { ownerKind: 'component', ownerId: 'task_contract_store' }, typedRecord: true, artifactBinding: 'T-001' },
    evidenceState: 'current',
    ...patch,
  });
}

/**
 * A canonical value per fact, in the exact closed shape the contract requires.
 * The verdict/readiness and closeout/lifecycle invariants stay at
 * `insufficient_evidence` here so a coverage baseline never invents drift.
 */
const CANONICAL_VALUES = Object.freeze({
  contract_readiness: { readiness: 'agent-ready', contractDigest: `sha256:v1:${'a'.repeat(64)}` },
  runtime_blocked_state: { blocked: false, transitionId: null, blockerRef: null },
  task_lifecycle_status: { status: 'in-progress', terminal: false },
  labels: { names: ['status:in-progress'] },
  comments: { recordType: 'agenticloop.review-checkpoint', artifactRef: 'commit:aaa' },
  review_readiness: { ready: false, reviewedArtifact: null },
  review_verdict: { verdict: 'pending', reviewedArtifact: null },
  audit_state: { auditId: null, certifiedArtifact: null },
  terminal_closeout: { closedOut: false, coveredTaskId: 'T-001', gateDigest: null },
});

function factDefinition(factId) {
  return TRANSITION_FACTS.find(fact => fact.factId === factId);
}

function canonicalAuthority(factId) {
  const definition = factDefinition(factId);
  return {
    producer: { ...definition.producer },
    persister: { ...definition.persister },
    typedRecord: true,
    artifactBinding: 'T-001',
  };
}

/** One current, canonically attributed observation of a single fact. */
function factObservation(backend, factId, patch = {}) {
  return observation({
    backend,
    factId,
    carrier: { applicability: 'applicable', identity: `${backend}-carrier:${factId}` },
    value: CANONICAL_VALUES[factId],
    authority: canonicalAuthority(factId),
    evidenceState: 'current',
    ...patch,
  });
}

/**
 * Every applicable fact for a backend, observed once.
 *
 * Authority-sensitive reconciliation requires the whole applicable fact set;
 * a test that wants to prove one relation still has to supply the rest, which
 * is exactly the discipline the contract now enforces on callers.
 */
function fullCoverage(backend, overrides = {}) {
  return TRANSITION_FACTS
    .filter(fact => fact.carriers[backend].applicable === true)
    .map(fact => {
      const override = overrides[fact.factId];
      if (override === null) return null;
      if (override && typeof override === 'object' && override.kind) return override;
      return factObservation(backend, fact.factId, override ?? {});
    })
    .filter(Boolean);
}

/** Full applicable coverage with specific observations substituted per fact. */
function coverageWith(backend, ...extra) {
  const byFact = new Map(fullCoverage(backend).map(observed => [observed.factId, observed]));
  for (const observed of extra) byFact.set(observed.factId, observed);
  return [...byFact.values()];
}

describe('projection observation shape', () => {
  it('binds every observation to a canonical transition-contract fact', () => {
    const observed = readiness();
    assert.equal(observed.kind, PROJECTION_OBSERVATION_KIND);
    assert.equal(observed.schemaVersion, PROJECTION_OBSERVATION_SCHEMA_VERSION);
    assert.ok(PROJECTION_FACT_IDS.includes(observed.factId));
    assert.deepEqual([...PROJECTION_FACT_IDS], TRANSITION_FACTS.map(fact => fact.factId));
    assert.match(observed.valueDigest, /^sha256:agenticloop\.projection-observation\.v1:[0-9a-f]{64}$/);
    assert.throws(() => observation({
      factId: 'not_a_canonical_fact',
      carrier: { applicability: 'applicable', identity: 'x' },
      value: null,
      evidenceState: 'current',
    }), /canonical transition-contract fact/);
  });

  it('derives no second handwritten fact inventory', () => {
    const source = readFileSync(SOURCE, 'utf8');
    for (const factId of PROJECTION_FACT_IDS) {
      // Facts may be referenced by invariants but the inventory itself is imported.
      assert.equal(source.includes(`factId: '${factId}'`), false, factId);
    }
    assert.match(source, /from '\.\/transition-contract\.js'/);
  });

  it('rejects host-local state without generic recorded provenance', () => {
    assert.throws(() => readiness({ stateProvenance: 'host_local_state', sourceRef: null }),
      /host_local_state requires a recorded provenance reference/);
    const recorded = readiness({ stateProvenance: 'host_local_state', sourceRef: '.agenticloop/tmp/host-notes.md' });
    assert.equal(recorded.stateProvenance, 'host_local_state');
  });

  it('has no host-tool-specific exception', () => {
    const source = readFileSync(SOURCE, 'utf8');
    assert.equal(/\.serena/.test(source), false);
  });

  it('rejects current facts whose authority does not match the canonical producer and persister', () => {
    assert.throws(() => readiness({
      authority: {
        producer: { ownerKind: 'workflow_role', ownerId: 'engineer' },
        persister: { ownerKind: 'component', ownerId: 'task_contract_store' },
        typedRecord: true,
        artifactBinding: 'T-001',
      },
    }), /authority producer.*maintainer/);
    assert.throws(() => readiness({
      authority: {
        producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
        persister: { ownerKind: 'component', ownerId: 'backend_projection' },
        typedRecord: true,
        artifactBinding: 'T-001',
      },
    }), /authority persister.*task_contract_store/);
  });

  it('rejects null or untyped current authoritative fact evidence', () => {
    assert.throws(() => readiness({ value: null }), /must carry a non-null canonical fact value/);
    assert.throws(() => readiness({
      authority: {
        producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' },
        persister: { ownerKind: 'component', ownerId: 'task_contract_store' },
        typedRecord: false,
        artifactBinding: null,
      },
    }), /must carry a typed record/);
  });
});

describe('carrier applicability', () => {
  it('represents files labels as non-applicable rather than missing', () => {
    const filesLabels = createProjectionObservation({
      factId: 'labels',
      backend: 'files',
      carrier: { applicability: 'not_applicable', identity: null },
      value: null,
      evidenceState: null,
      observedAt: null,
      invalidatedBy: [],
      stateProvenance: null,
    });
    const reconciled = reconcileProjections({ backend: 'files', observations: [...fullCoverage('files'), filesLabels] });
    const fact = reconciled.reconciliation.facts.find(item => item.factId === 'labels');
    assert.equal(fact.relation, 'not_applicable');
    assert.equal(fact.evidenceState, null);
    assert.equal(reconciled.result.errors.length, 0);
  });

  it('rejects a files labels observation that claims an applicable carrier', () => {
    const reconciled = reconcileProjections({
      backend: 'files',
      observations: [{
        kind: PROJECTION_OBSERVATION_KIND,
        schemaVersion: PROJECTION_OBSERVATION_SCHEMA_VERSION,
        factId: 'labels',
        backend: 'files',
        carrier: { applicability: 'applicable', identity: 'issue labels' },
        value: { names: ['blocked'] },
        valueDigest: null,
        evidenceState: 'current',
        authority: { producer: null, persister: null, typedRecord: false, artifactBinding: null },
        observedAt: OBSERVED_AT,
        invalidatedBy: ['label_set'],
        stateProvenance: 'workflow_state',
        sourceRef: null,
        transport: null,
      }],
    });
    assert.equal(reconciled.ok, false);
    assert.ok(reconciled.result.diagnostics.some(item => item.code === 'projection.carrier.not_applicable'));
  });

  it('does not report a non-applicable files carrier as missing evidence', () => {
    const reconciled = reconcileProjections({ backend: 'files', observations: [] });
    const fact = reconciled.reconciliation.facts.find(item => item.factId === 'labels');
    assert.equal(fact.relation, 'not_applicable');
    const comments = reconciled.reconciliation.facts.find(item => item.factId === 'comments');
    assert.equal(comments.relation, 'evidence_absent');
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.result.evidenceState, 'missing');
    assert.equal(reconciled.result.disposition, 'needs_context');
    assert.equal(reconciled.reconciliation.authoritySensitiveConclusion, 'blocked');
  });
});

describe('distinct facts are not contradictions', () => {
  it('accepts agent-ready contract state beside a current structured runtime blocker', () => {
    const blocked = observation({
      factId: 'runtime_blocked_state',
      carrier: { applicability: 'applicable', identity: 'role-return:blocked-1' },
      value: { blocked: true, transitionId: 'transition:impl-1', blockerRef: 'blocker:missing-credential' },
      authority: { producer: { ownerKind: 'contextual_role', ownerId: 'producing_role' }, persister: { ownerKind: 'component', ownerId: 'task_contract_store' }, typedRecord: true, artifactBinding: 'transition:impl-1' },
      evidenceState: 'current',
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', readiness(), blocked, lifecycle()) });
    assert.equal(reconciled.ok, true, reconciled.result.errors.join('\n'));
    assert.deepEqual(reconciled.reconciliation.contradictions, []);
    const invariant = reconciled.reconciliation.invariants.find(item => item.invariantId === 'readiness_vs_runtime_block');
    assert.equal(invariant.relation, 'distinct_fact');
    assert.equal(reconciled.reconciliation.authoritySensitiveConclusion, 'available');
  });

  it('treats a blocked label as label presence only and never rewrites readiness', () => {
    const labels = observation({
      factId: 'labels',
      carrier: { applicability: 'applicable', identity: 'issue labels' },
      value: { names: ['blocked'] },
      authority: { producer: { ownerKind: 'component', ownerId: 'backend_projection' }, persister: { ownerKind: 'component', ownerId: 'backend_projection' }, typedRecord: true, artifactBinding: null },
      evidenceState: 'current',
      invalidatedBy: ['label_set'],
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', readiness(), labels) });
    assert.equal(reconciled.ok, true, reconciled.result.errors.join('\n'));
    const invariant = reconciled.reconciliation.invariants.find(item => item.invariantId === 'labels_vs_contract_readiness');
    assert.equal(invariant.relation, 'label_presence_only');
    const fact = reconciled.reconciliation.facts.find(item => item.factId === 'contract_readiness');
    assert.equal(fact.relation, 'current');
    assert.equal(fact.authority, 'authoritative');
    const labelFact = reconciled.reconciliation.facts.find(item => item.factId === 'labels');
    assert.equal(labelFact.authority, 'authoritative_for_label_presence_only');
    assert.deepEqual(reconciled.reconciliation.contradictions, []);
  });

  it('gives an untyped prose comment no lifecycle authority', () => {
    const prose = observation({
      factId: 'comments',
      carrier: { applicability: 'applicable', identity: 'issue-comment:5501' },
      value: { recordType: null, artifactRef: null },
      authority: { producer: null, persister: null, typedRecord: false, artifactBinding: null },
      evidenceState: 'current',
      invalidatedBy: ['comment_set'],
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', lifecycle(), prose) });
    assert.equal(reconciled.ok, true, reconciled.result.errors.join('\n'));
    const fact = reconciled.reconciliation.facts.find(item => item.factId === 'comments');
    assert.equal(fact.relation, 'advisory');
    assert.ok(reconciled.result.warningDiagnostics.some(item => item.code === 'projection.authority.untyped'));
    assert.deepEqual(reconciled.reconciliation.contradictions, []);
  });

  it('accepts a typed comment carrier as authoritative for its own typed record only', () => {
    const typed = observation({
      factId: 'comments',
      carrier: { applicability: 'applicable', identity: 'issue-comment:5502' },
      value: { recordType: 'agenticloop.task-contract-record', artifactRef: 'T-001' },
      authority: { producer: { ownerKind: 'contextual_role', ownerId: 'producing_role' }, persister: { ownerKind: 'component', ownerId: 'backend_projection' }, typedRecord: true, artifactBinding: 'T-001' },
      evidenceState: 'current',
      invalidatedBy: ['comment_set'],
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', lifecycle(), typed) });
    const fact = reconciled.reconciliation.facts.find(item => item.factId === 'comments');
    assert.equal(fact.relation, 'current');
    assert.equal(fact.authority, 'authoritative_only_for_its_typed_record');
    assert.equal(reconciled.ok, true, reconciled.result.errors.join('\n'));
  });
});

describe('stale and contradictory evidence', () => {
  it('reports stale exact-head review evidence as superseded, not current and not drift', () => {
    const stale = observation({
      factId: 'review_readiness',
      carrier: { applicability: 'applicable', identity: 'review-entry-receipt:T-001' },
      value: { ready: true, reviewedArtifact: `sha256:${'b'.repeat(64)}` },
      authority: { producer: { ownerKind: 'component', ownerId: 'review_preparation_gate' }, persister: { ownerKind: 'component', ownerId: 'task_contract_store' }, typedRecord: true, artifactBinding: `sha256:${'b'.repeat(64)}` },
      evidenceState: 'stale',
      invalidatedBy: ['pr_head'],
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', readiness(), stale) });
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.result.evidenceState, 'stale');
    assert.equal(reconciled.result.disposition, 'superseded');
    const fact = reconciled.reconciliation.facts.find(item => item.factId === 'review_readiness');
    assert.equal(fact.relation, 'superseded');
    assert.deepEqual(reconciled.reconciliation.contradictions, []);
    assert.ok(reconciled.result.diagnostics.some(item => item.code === 'projection.evidence.superseded'));
  });

  it('reports a current closeout marker that contradicts the terminal task carrier as drift', () => {
    const closeout = observation({
      factId: 'terminal_closeout',
      carrier: { applicability: 'applicable', identity: 'closeout-comment:9001' },
      value: { closedOut: true, coveredTaskId: 'T-001', gateDigest: `sha256:${'c'.repeat(64)}` },
      authority: { producer: { ownerKind: 'component', ownerId: 'canonical_closeout_path' }, persister: { ownerKind: 'component', ownerId: 'backend_projection' }, typedRecord: true, artifactBinding: 'T-001' },
      evidenceState: 'current',
      invalidatedBy: ['closeout_gate_digest'],
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', lifecycle(), closeout) });
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.reconciliation.contradictions.length, 1);
    assert.equal(reconciled.reconciliation.contradictions[0].invariantId, 'terminal_closeout_vs_lifecycle_status');
    assert.ok(reconciled.result.diagnostics.some(item => item.code === 'projection.fact.contradiction'));
    assert.equal(reconciled.reconciliation.authoritySensitiveConclusion, 'blocked');
  });

  it('does not call a stale closeout marker a contradiction', () => {
    const staleCloseout = observation({
      factId: 'terminal_closeout',
      carrier: { applicability: 'applicable', identity: 'closeout-comment:9002' },
      value: { closedOut: true, coveredTaskId: 'T-001', gateDigest: `sha256:${'d'.repeat(64)}` },
      authority: { producer: { ownerKind: 'component', ownerId: 'canonical_closeout_path' }, persister: { ownerKind: 'component', ownerId: 'backend_projection' }, typedRecord: true, artifactBinding: 'T-001' },
      evidenceState: 'stale',
      invalidatedBy: ['closeout_gate_digest'],
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', lifecycle(), staleCloseout) });
    assert.deepEqual(reconciled.reconciliation.contradictions, []);
    assert.equal(reconciled.result.disposition, 'superseded');
  });

  it('reports two current carriers of one fact with different values as drift', () => {
    const reconciled = reconcileProjections({
      backend: 'github',
      observations: [
        ...coverageWith('github', lifecycle({ carrier: { applicability: 'applicable', identity: 'issue-body:11' } })),
        lifecycle({ carrier: { applicability: 'applicable', identity: 'issue-body:12' }, value: { status: 'done', terminal: true } }),
      ],
    });
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.reconciliation.contradictions[0].factId, 'task_lifecycle_status');
    assert.equal(reconciled.reconciliation.authoritySensitiveConclusion, 'blocked');
  });
});

describe('state provenance', () => {
  it('classifies provenanced host-local state without blocking', () => {
    const hostLocal = observation({
      factId: 'audit_state',
      carrier: { applicability: 'applicable', identity: '.agenticloop/audits/A-1.md' },
      value: { auditId: 'A-1', certifiedArtifact: null },
      authority: { producer: { ownerKind: 'workflow_role', ownerId: 'auditor' }, persister: { ownerKind: 'component', ownerId: 'audit_cli' }, typedRecord: true, artifactBinding: 'A-1' },
      evidenceState: 'current',
      stateProvenance: 'host_local_state',
      sourceRef: '.agenticloop/tmp/host-cache',
      invalidatedBy: ['audit_record_digest'],
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', readiness(), hostLocal) });
    assert.equal(reconciled.ok, true, reconciled.result.errors.join('\n'));
    assert.equal(reconciled.reconciliation.authoritySensitiveConclusion, 'available');
    const fact = reconciled.reconciliation.facts.find(item => item.factId === 'audit_state');
    assert.equal(fact.stateProvenance, 'host_local_state');
  });

  it('blocks authority-sensitive conclusions on unexplained drift', () => {
    const drift = observation({
      factId: 'audit_state',
      carrier: { applicability: 'applicable', identity: '.agenticloop/audits/A-2.md' },
      value: { auditId: 'A-2', certifiedArtifact: null },
      authority: {
        producer: { ownerKind: 'workflow_role', ownerId: 'auditor' },
        persister: { ownerKind: 'component', ownerId: 'audit_cli' },
        typedRecord: true,
        artifactBinding: 'A-2',
      },
      evidenceState: 'current',
      stateProvenance: 'unexplained_drift',
      invalidatedBy: ['audit_record_digest'],
    });
    const reconciled = reconcileProjections({ backend: 'github', observations: coverageWith('github', readiness(), drift) });
    assert.equal(reconciled.reconciliation.authoritySensitiveConclusion, 'blocked');
    assert.deepEqual(reconciled.reconciliation.unexplainedDrift, ['audit_state']);
    assert.ok(reconciled.result.diagnostics.some(item => item.code === 'projection.state.unexplained'));
  });
});

describe('backend equivalence', () => {
  function normalizedSet(backend, extras = []) {
    const carrierFor = identity => ({ applicability: 'applicable', identity });
    return [
      createProjectionObservation({
        factId: 'contract_readiness', backend, observedAt: OBSERVED_AT, stateProvenance: 'workflow_state',
        invalidatedBy: ['task_record_digest'], evidenceState: 'current',
        carrier: carrierFor(backend === 'files' ? '.agenticloop/task-contract-history/T-001.jsonl' : 'task-contract-comment:11'),
        value: { readiness: 'agent-ready', contractDigest: `sha256:v1:${'a'.repeat(64)}` },
        authority: { producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' }, persister: { ownerKind: 'component', ownerId: 'task_contract_store' }, typedRecord: true, artifactBinding: 'T-001' },
        transport: backend === 'github' ? { issueNumber: 11 } : null,
      }),
      createProjectionObservation({
        factId: 'task_lifecycle_status', backend, observedAt: OBSERVED_AT, stateProvenance: 'workflow_state',
        invalidatedBy: ['task_record_digest'], evidenceState: 'current',
        carrier: carrierFor(backend === 'files' ? '.agenticloop/tasks/T-001.md' : 'issue-body:11'),
        value: { status: 'in-progress', terminal: false },
        authority: { producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' }, persister: { ownerKind: 'component', ownerId: 'task_contract_store' }, typedRecord: true, artifactBinding: 'T-001' },
        transport: backend === 'github' ? { issueNumber: 11, htmlUrl: 'https://example.invalid/11' } : null,
      }),
      ...extras,
    ].reduce((set, observed) => {
      const index = set.findIndex(item => item.factId === observed.factId);
      if (index >= 0) set.splice(index, 1, observed);
      else set.push(observed);
      return set;
    }, fullCoverage(backend));
  }

  it('returns the same semantic verdict for equivalent normalized files and GitHub facts', () => {
    const filesSide = reconcileProjections({
      backend: 'files',
      observations: normalizedSet('files', [createProjectionObservation({
        factId: 'labels', backend: 'files', carrier: { applicability: 'not_applicable', identity: null },
        value: null, evidenceState: null, observedAt: null, invalidatedBy: [], stateProvenance: null,
      })]),
    });
    const githubSide = reconcileProjections({
      backend: 'github',
      observations: normalizedSet('github', [createProjectionObservation({
        factId: 'labels', backend: 'github', carrier: { applicability: 'applicable', identity: 'issue labels' },
        value: { names: ['agent-ready'] }, evidenceState: 'current', observedAt: OBSERVED_AT,
        invalidatedBy: ['label_set'], stateProvenance: 'workflow_state',
        authority: { producer: { ownerKind: 'component', ownerId: 'backend_projection' }, persister: { ownerKind: 'component', ownerId: 'backend_projection' }, typedRecord: true, artifactBinding: null },
      })]),
    });
    assert.equal(filesSide.ok, true, filesSide.result.errors.join('\n'));
    assert.equal(githubSide.ok, true, githubSide.result.errors.join('\n'));
    assert.equal(filesSide.reconciliation.verdictDigest, githubSide.reconciliation.verdictDigest);
    for (const factId of ['contract_readiness', 'task_lifecycle_status']) {
      const left = filesSide.reconciliation.facts.find(item => item.factId === factId);
      const right = githubSide.reconciliation.facts.find(item => item.factId === factId);
      assert.equal(left.valueDigest, right.valueDigest, factId);
      assert.equal(left.relation, right.relation, factId);
    }
  });

  it('keeps transport fields out of the semantic value digest', () => {
    const base = {
      factId: 'task_lifecycle_status', backend: 'github', observedAt: OBSERVED_AT,
      stateProvenance: 'workflow_state', invalidatedBy: ['task_record_digest'], evidenceState: 'current',
      carrier: { applicability: 'applicable', identity: 'issue-body:11' },
      value: { status: 'in-progress', terminal: false },
      authority: { producer: { ownerKind: 'workflow_role', ownerId: 'maintainer' }, persister: { ownerKind: 'component', ownerId: 'task_contract_store' }, typedRecord: true, artifactBinding: 'T-001' },
    };
    assert.equal(
      createProjectionObservation({ ...base, transport: { issueNumber: 11 } }).valueDigest,
      createProjectionObservation({ ...base, transport: { issueNumber: 4242, labels: ['x'] } }).valueDigest,
    );
  });
});

describe('reconciliation record', () => {
  it('reports every canonical fact exactly once in a closed, digest-bound record', () => {
    const reconciled = reconcileProjections({ backend: 'github', observations: [readiness(), lifecycle()] });
    const record = reconciled.reconciliation;
    assert.equal(record.kind, PROJECTION_RECONCILIATION_KIND);
    assert.equal(record.schemaVersion, PROJECTION_RECONCILIATION_SCHEMA_VERSION);
    assert.deepEqual(record.facts.map(item => item.factId), [...PROJECTION_FACT_IDS]);
    for (const fact of record.facts) assert.ok(PROJECTION_FACT_RELATIONS.includes(fact.relation), fact.relation);
    assert.match(record.digest, /^sha256:agenticloop\.projection-reconciliation\.v1:[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(record), true);
  });

  it('emits canonical validation-result diagnostics rather than a private error envelope', () => {
    const reconciled = reconcileProjections({ backend: 'github', observations: [readiness({ evidenceState: 'missing', value: null })] });
    assert.equal(reconciled.result.kind, 'agenticloop.validation-result');
    assert.equal(reconciled.result.command, 'projection reconcile');
    assert.equal(reconciled.result.evidenceState, 'missing');
    assert.equal(reconciled.result.disposition, 'needs_context');
  });

  it('names the canonical producer, persister, authority, source, and freshness rule per fact', () => {
    const reconciled = reconcileProjections({ backend: 'github', observations: fullCoverage('github') });
    for (const row of reconciled.reconciliation.facts) {
      const definition = factDefinition(row.factId);
      assert.deepEqual(row.producer, { ...definition.producer }, row.factId);
      assert.deepEqual(row.persister, { ...definition.persister }, row.factId);
      assert.equal(row.authority, definition.authority, row.factId);
      assert.equal(row.canonicalSource, definition.canonicalSource, row.factId);
      assert.equal(row.freshnessRule, definition.freshness, row.factId);
    }
  });
});

describe('serialized observation records are validated, never repaired', () => {
  function serialized(patch = {}) {
    return { ...structuredClone(readiness()), ...patch };
  }

  it('accepts an intact emitted record', () => {
    const check = validateProjectionObservationRecord(serialized());
    assert.equal(check.ok, true, check.errors.join('\n'));
  });

  for (const field of ['kind', 'schemaVersion', 'factId', 'backend', 'carrier', 'value', 'valueDigest',
    'evidenceState', 'authority', 'observedAt', 'invalidatedBy', 'stateProvenance', 'sourceRef', 'transport']) {
    it(`rejects a record with '${field}' deleted`, () => {
      const record = serialized();
      delete record[field];
      const check = validateProjectionObservationRecord(record);
      assert.equal(check.ok, false, `deleting ${field} must not be repaired`);
      assert.ok(check.errors.some(error => error.includes(field) || /missing required fields/.test(error)));
    });
  }

  it('rejects an unknown field', () => {
    const check = validateProjectionObservationRecord(serialized({ extra: true }));
    assert.equal(check.ok, false);
    assert.ok(check.errors.some(error => /unknown fields/.test(error)));
  });

  it('rejects a tampered valueDigest', () => {
    const check = validateProjectionObservationRecord(serialized({
      valueDigest: `sha256:agenticloop.projection-observation.v1:${'0'.repeat(64)}`,
    }));
    assert.equal(check.ok, false);
    assert.ok(check.errors.some(error => /valueDigest does not match/.test(error)));
  });

  it('rejects a value edited under a retained digest', () => {
    const check = validateProjectionObservationRecord(serialized({
      value: { readiness: 'blocked', contractDigest: `sha256:v1:${'a'.repeat(64)}` },
    }));
    assert.equal(check.ok, false);
    assert.ok(check.errors.some(error => /valueDigest does not match/.test(error)));
  });

  it('is total over arbitrary JSON-compatible input', () => {
    for (const value of [null, undefined, 0, '', 'text', [], [1], true, {}, { kind: 1 }]) {
      const check = validateProjectionObservationRecord(value);
      assert.equal(check.ok, false);
      assert.ok(Array.isArray(check.errors) && check.errors.length > 0);
    }
  });

  it('refuses a supplied record with no kind or schema version inside reconciliation', () => {
    const record = serialized();
    delete record.kind;
    delete record.schemaVersion;
    const reconciled = reconcileProjections({ backend: 'github', observations: [record] });
    assert.equal(reconciled.ok, false);
    assert.ok(reconciled.result.diagnostics.some(item => item.code === 'projection.observation.invalid'));
  });
});

describe('required observation coverage', () => {
  it('blocks an authority-sensitive conclusion from a single observation', () => {
    const sparse = reconcileProjections({ backend: 'github', observations: [readiness()] });
    assert.equal(sparse.reconciliation.authoritySensitiveConclusion, 'blocked');
    assert.ok(sparse.reconciliation.missingRequiredFacts.length > 0);
    assert.ok(sparse.result.diagnostics.some(item => item.code === 'evidence.missing'));
    // The partial reconciliation is still represented: the observed fact keeps
    // its exact relation rather than being erased by the missing ones.
    const observed = sparse.reconciliation.facts.find(item => item.factId === 'contract_readiness');
    assert.equal(observed.relation, 'current');
  });

  it('keeps zero observations at missing / needs_context', () => {
    const empty = reconcileProjections({ backend: 'github', observations: [] });
    assert.equal(empty.result.evidenceState, 'missing');
    assert.equal(empty.result.disposition, 'needs_context');
    assert.equal(empty.reconciliation.authoritySensitiveConclusion, 'blocked');
    assert.deepEqual(empty.reconciliation.missingRequiredFacts, [...requiredProjectionFactIds('github')]);
  });

  it('never counts a non-applicable carrier as a missing required fact', () => {
    const reconciled = reconcileProjections({ backend: 'files', observations: fullCoverage('files') });
    assert.deepEqual(reconciled.reconciliation.missingRequiredFacts, []);
    assert.equal(reconciled.reconciliation.requiredFacts.includes('labels'), false);
    const labels = reconciled.reconciliation.facts.find(item => item.factId === 'labels');
    assert.equal(labels.relation, 'not_applicable');
  });

  it('makes an authority-sensitive conclusion available on full required coverage', () => {
    const reconciled = reconcileProjections({ backend: 'github', observations: fullCoverage('github') });
    assert.equal(reconciled.ok, true, reconciled.result.errors.join('\n'));
    assert.deepEqual(reconciled.reconciliation.missingRequiredFacts, []);
    assert.equal(reconciled.reconciliation.authoritySensitiveConclusion, 'available');
  });

  it('never reports two non-applicable null identities as the same carrier', () => {
    const absent = () => createProjectionObservation({
      factId: 'labels', backend: 'files', carrier: { applicability: 'not_applicable', identity: null },
      value: null, evidenceState: null, observedAt: null, invalidatedBy: [], stateProvenance: null,
    });
    const reconciled = reconcileProjections({
      backend: 'files',
      observations: [...fullCoverage('files'), absent(), absent()],
    });
    assert.equal(
      reconciled.result.diagnostics.some(item => /same carrier identity/.test(item.message)),
      false,
    );
  });
});
