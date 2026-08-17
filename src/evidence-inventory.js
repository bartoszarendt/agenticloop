/**
 * What every persisted evidence class is for, and who is allowed to see it.
 *
 * Two findings meet here. C12-F5 asked for a storage taxonomy, because Agentic
 * Loop wrote generated state under `.agenticloop/` and then rejected it at the
 * clean gate - a class confusion, not a bug in either component. And the
 * remediation's governing principle asks the harder question of every field:
 *
 * > Rich internal state must produce a simpler external workflow. Every
 * > persisted field must have at least one named consumer and support a
 * > decision, invariant, recovery operation, audit claim, coordination
 * > boundary, or bounded analysis. Otherwise it must be derived, transient, or
 * > removed.
 *
 * A record kept because it might be useful later is a record nobody maintains
 * and everybody has to reason about. So each class below names its producer,
 * its consumer, the decision it changes, whether it could be derived instead,
 * how long it must survive, which storage class it belongs to, and the bounded
 * projection each role receives.
 *
 * The last field is the one that does work at runtime. An Engineer does not
 * need activation internals, audit records, or closeout state to implement a
 * bounded change; handing them over enlarges the context it must reason about
 * and the surface it might act on, for no implementation benefit. `visibleTo`
 * is that boundary, stated per class rather than per call site.
 *
 * This inventory is checked against the source's own storage roots, so it
 * cannot quietly go stale while the code grows a new class.
 */

/**
 * The four storage classes (C12R.4).
 *
 * The clean-gate rule is the reason the taxonomy exists: a command must not
 * write ordinary output into a class its next required gate rejects.
 */
export const STORAGE_CLASSES = Object.freeze({
  transient_scratch: Object.freeze({
    id: 'transient_scratch',
    location: '.agenticloop/tmp/',
    committed: false,
    cleanGate: 'excluded',
    retention: 'until the operation that wrote it completes; safe to delete at any time',
    rule: 'Ordinary command output that no later gate consumes. Excluded from the clean gate at every boundary, so it can never self-block the next step.',
  }),
  operator_owned_authenticated_state: Object.freeze({
    id: 'operator_owned_authenticated_state',
    location: '~/.agenticloop/operator-activation/ (outside every target repository)',
    committed: false,
    cleanGate: 'not_applicable',
    retention: 'for the life of the operator key; superseded material is preserved, never deleted',
    rule: 'Operator confirmation keys, external revocation tombstones, and migration receipts. Never inside a target repository, so repository content can never decide whether operator authority exists.',
  }),
  durable_project_evidence: Object.freeze({
    id: 'durable_project_evidence',
    location: '.agenticloop/** (committed)',
    committed: true,
    cleanGate: 'fails_closed_until_committed',
    retention: 'for the life of the project history; append-only where the class says so',
    rule: 'Evidence a later gate reads to make a decision. It must be committed by its owning role before the gate that consumes it runs; uncommitted durable evidence fails closed rather than being auto-staged.',
  }),
  product_task_carrier_state: Object.freeze({
    id: 'product_task_carrier_state',
    location: '.agenticloop/tasks/ and the product tree',
    committed: true,
    cleanGate: 'scope_relevant',
    retention: 'for the life of the project history',
    rule: 'The task contract and the product itself. Changes here are material by definition and invalidate bound evidence.',
  }),
});

const ROLES = Object.freeze(['orchestrator', 'maintainer', 'engineer', 'auditor']);

function entry(value) {
  return Object.freeze(value);
}

/**
 * Every persisted evidence class, with the seven fields the exit gate requires.
 *
 * `derivable` answers "could this be recomputed from a stronger canonical
 * source?". Where the answer is yes, the class must justify persisting anyway -
 * and two of them below do not, which is recorded rather than hidden.
 */
export const EVIDENCE_INVENTORY = Object.freeze({
  task_record: entry({
    root: '.agenticloop/tasks',
    producer: 'maintainer',
    consumer: 'every gate; the task contract is the root authority',
    decision: 'what work is authorized, in what scope, against which acceptance criteria',
    derivable: false,
    retention: 'project history',
    storageClass: 'product_task_carrier_state',
    visibleTo: Object.freeze([...ROLES]),
  }),
  task_contract_history: entry({
    root: '.agenticloop/task-contract-history',
    producer: 'maintainer',
    consumer: 'handoff preflight, packet preparation, closeout',
    decision: 'whether the current contract descends from a trusted baseline; a broken chain blocks dispatch',
    derivable: false,
    retention: 'project history, append-only; deletion is itself a violation',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer', 'auditor']),
  }),
  decomposition: entry({
    root: '.agenticloop/decompositions',
    producer: 'maintainer',
    consumer: 'handoff preflight, packet preparation, activation work-unit derivation',
    decision: 'which tasks form the ready set, and whether this task may be dispatched from it',
    derivable: false,
    retention: 'until superseded by a regenerated scan; prior scans need not be kept',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer']),
  }),
  activation_grant: entry({
    root: '.agenticloop/activations',
    producer: 'operator (interactive CLI) or a protected host boundary',
    consumer: 'packet preparation, role start, closeout',
    decision: 'whether the operator authorized this exact task, and until when',
    derivable: false,
    retention: 'until expiry plus the life of any attempt it authorized, because closeout evaluates it at the consumption instant',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer']),
  }),
  dispatch_consumption: entry({
    root: '.agenticloop/handoffs/dispatch',
    producer: 'role start',
    consumer: 'carrier lineage, return verification, packet conservation, measurement',
    decision: 'which execution attempt is live, and what product base it started from',
    derivable: false,
    retention: 'project history; it is the only record of when an attempt began',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer', 'engineer']),
  }),
  carrier_mutation_receipt: entry({
    root: '.agenticloop/handoffs/task-mutations',
    producer: 'engineer',
    consumer: 'carrier lineage, return verification, packet conservation',
    decision: 'whether the carrier edits during an attempt form one unbroken chain',
    derivable: false,
    retention: 'project history; a gap in the chain is unrecoverable',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer', 'engineer']),
  }),
  execution_attempt_abandonment: entry({
    root: '.agenticloop/handoffs/attempts',
    producer: 'operator, through an explicit command',
    consumer: 'packet conservation, measurement',
    decision: 'whether a new packet may be minted while a prior attempt holds recorded work',
    derivable: false,
    retention: 'project history; it explains why an attempt has no return',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer']),
  }),
  return_verification: entry({
    root: '.agenticloop/returns/verifications',
    producer: 'return verification',
    consumer: 'review entry, closeout',
    decision: 'whether an authenticated return may enter review',
    derivable: false,
    retention: 'project history',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer', 'auditor']),
  }),
  historical_adoption: entry({
    root: '.agenticloop/adoptions',
    producer: 'operator, through an explicit command',
    consumer: 'status projection; closeout once it consumes adoptions',
    decision: 'whether work predating the lifecycle has a truthful terminal state, and at what assurance',
    derivable: false,
    retention: 'project history; it is the sole record of which evidence classes were absent',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer', 'auditor']),
  }),
  handoff_derived_evidence: entry({
    root: '.agenticloop/handoffs/derived-evidence',
    producer: 'refresh-handoff-evidence',
    consumer: 'handoff preflight, as a cached observation only',
    // Honest accounting, and the one entry that does not fully earn its place.
    // It changes no gate outcome - it carries `authority: derived_only` - so
    // by the governing principle it is a candidate for becoming transient.
    // Recorded as such rather than quietly kept.
    decision: 'none that is authoritative; it only spares preflight from recomputing observations it could derive itself',
    derivable: true,
    derivabilityNote: 'recomputable from the task record, decomposition, and Git state; kept as a bounded cache with no authority',
    reviewDisposition: 'candidate for reclassification to transient_scratch; retained for now because the refresh command is a documented operator surface',
    retention: 'until the next refresh; safe to delete, at the cost of recomputation',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer']),
  }),
  closeout_waiver: entry({
    root: '.agenticloop/closeout-waivers',
    producer: 'operator, through an interactive confirmation',
    consumer: 'closeout',
    decision: 'whether a named absent-evidence dimension is excused for one work unit',
    derivable: false,
    retention: 'one hour; the record is deliberately short-lived so it cannot become standing policy',
    storageClass: 'durable_project_evidence',
    visibleTo: Object.freeze(['orchestrator', 'maintainer']),
  }),
  scratch: entry({
    root: '.agenticloop/tmp',
    producer: 'any command',
    consumer: 'the command that wrote it, within one invocation',
    decision: 'none; it exists so ordinary output has somewhere to go that no gate reads',
    derivable: true,
    derivabilityNote: 'by definition; nothing downstream depends on it',
    retention: 'none guaranteed',
    storageClass: 'transient_scratch',
    visibleTo: Object.freeze([...ROLES]),
  }),
  operator_activation_key: entry({
    root: '~/.agenticloop/operator-activation',
    producer: 'operator provisioning',
    consumer: 'activation signing and verification',
    decision: 'whether operator-confirmed evidence can be produced or trusted at all',
    derivable: false,
    retention: 'life of the key; superseded spellings preserved for migration',
    storageClass: 'operator_owned_authenticated_state',
    visibleTo: Object.freeze([]),
    visibilityNote: 'no workflow role receives this class; it is operator-only material outside every repository',
  }),
});

const REQUIRED_FIELDS = Object.freeze([
  'root', 'producer', 'consumer', 'decision', 'derivable', 'retention', 'storageClass', 'visibleTo',
]);

/**
 * Check the inventory against its own contract.
 *
 * Every class must carry all seven fields, name a real storage class, list only
 * real roles, and - where it says it is derivable - justify why it is persisted
 * anyway. A class that is derivable with no justification is exactly the "kept
 * because it might be useful" case the principle rejects.
 */
export function validateEvidenceInventory(inventory = EVIDENCE_INVENTORY) {
  const errors = [];
  for (const [name, item] of Object.entries(inventory)) {
    for (const field of REQUIRED_FIELDS) {
      if (item[field] === undefined || item[field] === null || item[field] === '') {
        errors.push(`${name}: missing required field '${field}'`);
      }
    }
    if (!Object.hasOwn(STORAGE_CLASSES, item.storageClass ?? '')) {
      errors.push(`${name}: unknown storage class '${item.storageClass}'`);
    }
    if (!Array.isArray(item.visibleTo)) {
      errors.push(`${name}: visibleTo must be an array of workflow roles`);
    } else {
      for (const role of item.visibleTo) {
        if (!ROLES.includes(role)) errors.push(`${name}: visibleTo names unknown role '${role}'`);
      }
      if (item.visibleTo.length === 0 && !item.visibilityNote) {
        errors.push(`${name}: a class visible to no role must state why`);
      }
    }
    if (item.derivable === true && !item.derivabilityNote) {
      errors.push(`${name}: a derivable class must justify why it is persisted anyway`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The bounded set of evidence classes one role may receive.
 *
 * Used to keep activation, audit, and closeout internals out of an Engineer's
 * context: implementing a bounded change needs the contract, the packet
 * lineage, and its own receipts - not the authority machinery around them.
 */
export function evidenceVisibleToRole(roleId, inventory = EVIDENCE_INVENTORY) {
  if (!ROLES.includes(roleId)) throw new TypeError(`unknown workflow role '${String(roleId)}'`);
  return Object.freeze(
    Object.entries(inventory)
      .filter(([, item]) => item.visibleTo.includes(roleId))
      .map(([name]) => name)
      .sort()
  );
}

/** Every workflow role this inventory is expressed over. */
export const INVENTORY_ROLES = Object.freeze([...ROLES]);
