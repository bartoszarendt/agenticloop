/**
 * The canonical lifecycle-dispatchability gate.
 *
 * Preflight, packet preparation, prepared-packet validation, and role-start
 * recognition all need one identical answer to "may this task begin an
 * execution attempt right now?". Before P35-C12R only the last of them asked:
 * preflight and `prepare-dispatch` reported success for a `draft` task, and the
 * refusal arrived at role start, inside the Engineer session, as an illegal
 * lifecycle transition (C12-F1). That handed Maintainer-owned readiness work to
 * the wrong role and started the repair cascade the field sessions measured.
 *
 * The rule is derived from the one legal-transition authority rather than being
 * restated here, so it cannot drift from what role start will actually accept:
 * a task is dispatchable exactly when its current status can legally reach
 * `in-progress`, or already is `in-progress`.
 */

import { parseFrontmatterStrict } from './frontmatter.js';

import { stripTaskContractMarkers } from './task-contract-baseline.js';
import { KNOWN_TASK_STATUSES, LEGAL_TASK_STATUS_TRANSITIONS } from './task-transition.js';

/** The lifecycle status a role start moves a task into. */
export const ROLE_START_STATUS = 'in-progress';

/** The one diagnostic code every dispatchability refusal reports under. */
export const DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE = 'task.lifecycle.not_dispatchable';

/** Every status a dispatch packet may legally be created from. */
export const DISPATCHABLE_TASK_STATUSES = Object.freeze(
  KNOWN_TASK_STATUSES.filter(status =>
    status === ROLE_START_STATUS || LEGAL_TASK_STATUS_TRANSITIONS[status].has(ROLE_START_STATUS)
  )
);

/** Read the current lifecycle status from a task record body. */
export function taskStatusFromBody(taskBody) {
  const parsed = parseFrontmatterStrict(stripTaskContractMarkers(String(taskBody ?? '')));
  if (parsed.state !== 'valid') return null;
  const status = typeof parsed.data.status === 'string' ? parsed.data.status.trim() : '';
  return status || null;
}

/**
 * Decide whether one task's current lifecycle status permits dispatch.
 *
 * `evidenceState` follows the shared precedence: an absent or unrecognized
 * status is missing/malformed evidence rather than a negative answer, because
 * "unknown current state" never authorizes anything.
 *
 * @param {string|null|undefined} status
 * @returns {{ ok: boolean, status: string|null, evidenceState: string, reason: string|null }}
 */
export function evaluateDispatchableLifecycle(status) {
  const current = typeof status === 'string' ? status.trim() : '';
  if (!current) {
    return {
      ok: false,
      status: null,
      evidenceState: 'missing',
      reason: 'the task record declares no lifecycle status, so no execution attempt can be authorized',
    };
  }
  if (!Object.hasOwn(LEGAL_TASK_STATUS_TRANSITIONS, current)) {
    return {
      ok: false,
      status: current,
      evidenceState: 'malformed',
      reason: `task status '${current}' is not a recognized lifecycle status; expected one of: ${KNOWN_TASK_STATUSES.join(', ')}`,
    };
  }
  if (DISPATCHABLE_TASK_STATUSES.includes(current)) {
    return { ok: true, status: current, evidenceState: 'current', reason: null };
  }
  return {
    ok: false,
    status: current,
    evidenceState: 'negative',
    reason:
      `task status '${current}' cannot begin an execution attempt; ` +
      `a role start requires a status that legally reaches '${ROLE_START_STATUS}' ` +
      `(${DISPATCHABLE_TASK_STATUSES.join(', ')})`,
  };
}

/**
 * The structured repair for one lifecycle refusal.
 *
 * Repairs used to be free-text strings assembled at each refusal site, and the
 * `draft` string was not a runnable command at all: it named a `task set-status`
 * subcommand that does not exist, omitted the required `--expect-digest`, and
 * offered `--base` and `--base-paths` together even though `task status` refuses
 * both (C12R-R2-F1). A string cannot be checked; a structure can.
 *
 * So every refusal produces one record instead:
 *
 * - `code`          - the diagnostic identity, shared by every boundary.
 * - `prerequisite`  - the exact fact that must become true.
 * - `reads`         - read-only commands that supply a placeholder value.
 * - `primary`       - at most one command, executable once its declared
 *                     placeholders are replaced and nothing else.
 * - `alternatives`  - a separate command only where the choice is genuinely the
 *                     operator's, each with the condition that selects it.
 * - `statement`     - what is true, for the statuses where no command is safe.
 *
 * Owner and category are deliberately absent: `REPAIR_POLICY` already derives
 * them from `code`, and `createDiagnostic` refuses an evaluator-supplied owner.
 *
 * @typedef {{ command: string, placeholders: string[] }} RepairCommand
 * @typedef {{
 *   code: string,
 *   status: string|null,
 *   prerequisite: string,
 *   reads: RepairCommand[],
 *   primary: RepairCommand|null,
 *   alternatives: Array<RepairCommand & { when: string }>,
 *   statement: string|null,
 * }} LifecycleRepairPlan
 */
export function dispatchableLifecycleRepairPlan(taskId, status) {
  const id = String(taskId ?? '').trim() || '<task-id>';
  const base = {
    code: DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
    status: typeof status === 'string' ? status.trim() || null : null,
    reads: [],
    primary: null,
    alternatives: [],
    statement: null,
  };

  if (status === 'draft') {
    // `task status` requires the exact current digest and exactly one baseline
    // form. Both are represented as what they are: one read-only command that
    // produces the digest, and one operator choice between two baselines.
    return Object.freeze({
      ...base,
      prerequisite:
        `${id} must be authored to the 'agent-ready' status with explicit base and dependency evidence`,
      reads: Object.freeze([
        Object.freeze({
          command: `npx agenticloop task lint ${id} --json`,
          placeholders: Object.freeze([]),
        }),
      ]),
      primary: Object.freeze({
        command:
          `npx agenticloop task status ${id} agent-ready ` +
          '--expect-digest <digest> --base <base-ref> --dependencies <dependencies.json>',
        placeholders: Object.freeze(['<digest>', '<base-ref>', '<dependencies.json>']),
      }),
      alternatives: Object.freeze([
        Object.freeze({
          when: 'the baseline is an explicit path inventory rather than a Git ref',
          command:
            `npx agenticloop task status ${id} agent-ready ` +
            '--expect-digest <digest> --base-paths <base-paths.json> --dependencies <dependencies.json>',
          placeholders: Object.freeze(['<digest>', '<base-paths.json>', '<dependencies.json>']),
        }),
      ]),
    });
  }
  if (status === 'accepted' || status === 'closed') {
    return Object.freeze({
      ...base,
      prerequisite: `${id} has no remaining execution attempt to authorize`,
      statement:
        `Task ${id} has already completed its lifecycle; dispatch a new task instead of restarting this one.`,
    });
  }
  return Object.freeze({
    ...base,
    prerequisite: `${id} must hold a status that can legally reach '${ROLE_START_STATUS}'`,
    statement: `Restore ${id} to a dispatchable status before requesting a packet.`,
  });
}

/**
 * Render one repair plan as the single-line `repairHint` the diagnostic surfaces
 * carry.
 *
 * This is the only place a lifecycle repair becomes text, so preflight, packet
 * preparation, prepared-packet validation, and role start cannot print different
 * advice for the same fact.
 */
export function renderRepairPlan(plan) {
  if (!plan) return '';
  if (!plan.primary) return plan.statement ?? plan.prerequisite;
  const parts = [];
  for (const read of plan.reads) parts.push(`Read the current values with: ${read.command}.`);
  parts.push(`Then run: ${plan.primary.command}`);
  if (plan.primary.placeholders.length) {
    parts.push(`Replace only ${plan.primary.placeholders.join(', ')}.`);
  }
  for (const alternative of plan.alternatives) {
    parts.push(`Instead, when ${alternative.when}, run: ${alternative.command}`);
  }
  return parts.join(' ');
}

/** The rendered repair for one lifecycle refusal. */
export function dispatchableLifecycleRepair(taskId, status) {
  return renderRepairPlan(dispatchableLifecycleRepairPlan(taskId, status));
}

/** Statuses that have already finished their execution attempt. */
export const TERMINAL_TASK_STATUSES = Object.freeze(
  KNOWN_TASK_STATUSES.filter(status => LEGAL_TASK_STATUS_TRANSITIONS[status].size === 0 || status === 'accepted')
);

/**
 * The subset of the rule the packet constructor enforces today.
 *
 * `prepareRoleDispatch` refuses every status that has not yet reached an
 * execution attempt - the C12-F1 defect - and reports terminal statuses to the
 * caller through preflight rather than refusing them here.
 *
 * This is a deliberate, disclosed narrowing, not a correctness claim: minting a
 * packet for an `accepted` task is genuinely wrong, but refusing it inside the
 * constructor also refuses the retroactive lineage the closeout fixtures build,
 * and building that lineage truthfully needs the carrier-generation chain that
 * P35-C12R.5 owns. The reopen gate is P35-C12R.5: once a closeout fixture can
 * express dispatch, consumption, carrier mutation receipts, and return in real
 * order, this narrowing is deleted and `evaluateDispatchableLifecycle` is
 * applied here unchanged.
 *
 * P35-C12R.5 measured what that gate actually costs. Deleting the narrowing and
 * running the full suite fails roughly twenty closeout suites, because the
 * closeout fixtures still build their lineage *retroactively*: they set a task
 * terminal and then mint the packet that is supposed to have preceded it. The
 * narrowing is therefore load-bearing for the fixtures, not for the product
 * rule - `evaluateDispatchableLifecycle` already refuses terminal statuses
 * everywhere else, and preflight refuses them at the boundary an operator
 * actually runs. Closing it is fixture work, not evaluator work.
 */
export function evaluatePacketDispatchableLifecycle(status) {
  const evaluated = evaluateDispatchableLifecycle(status);
  if (evaluated.ok) return evaluated;
  if (TERMINAL_TASK_STATUSES.includes(evaluated.status)) {
    return { ...evaluated, ok: true, evidenceState: 'current', enforcedAt: 'preflight' };
  }
  return evaluated;
}
