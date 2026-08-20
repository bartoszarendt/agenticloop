/**
 * The ordered sequence a green preflight is actually predicting.
 *
 * `task handoff-preflight` validates a point-in-time snapshot. It does not
 * model the write-and-commit sequence it is about to require, so its green was
 * never a prediction: in the field it returned `ok: true` at 19:27:16, the
 * required next action wrote an untracked abandonment receipt at 19:28:44, and
 * `prepare-dispatch` refused with `worktree.clean_gate.failed` three seconds
 * later. The same shape recurred an hour later, with `dispatch.packet.stale`
 * after role start legitimately mutated the carrier.
 *
 * Neither refusal is wrong. What was wrong is that one successful preflight was
 * supposed to imply dispatch and role start will succeed, and a green that does
 * not survive its own prescribed next action is a false green.
 *
 * So preflight reports the whole ordered sequence - every step it is about to
 * require, what each step writes, and which of those writes must be committed
 * before the following step's gate can pass. This is the `readiness-plan`
 * ordered-sequence idea applied to the recovery path.
 */

/** Workflow state a step writes must be committed before the next gate reads it. */
const CLEAN_GATE_REASON =
  'the dispatch clean gate refuses relevant untracked workflow state, so this write must be committed before the next step';

function step(order, { command, writes = [], commitRequired = false, reason = null, gate = null }) {
  return Object.freeze({
    order,
    command,
    writes: Object.freeze([...writes]),
    commitRequired,
    commitReason: commitRequired ? (reason ?? CLEAN_GATE_REASON) : null,
    gate,
  });
}

/**
 * Derive the ordered dispatch sequence from the facts preflight already has.
 *
 * @param {{
 *   taskId: string,
 *   backend?: string,
 *   host?: string|null,
 *   liveAttempt?: { attemptId: string }|null,
 *   newPacketPermitted?: boolean,
 * }} input
 * @returns {{ steps: object[], commitCount: number }}
 */
export function deriveHandoffSequence({
  taskId,
  backend = 'files',
  host = null,
  liveAttempt = null,
  newPacketPermitted = true,
} = {}) {
  const id = String(taskId ?? '<id>');
  const hostArgument = host ? `--host ${host} ` : '--host <host> ';
  const steps = [];
  let order = 0;

  // A live attempt that has recorded Engineer work is conserved: it reaches a
  // canonical return or it is explicitly abandoned. Either exit writes durable
  // state, and the abandonment receipt is the one the field run tripped over.
  if (!newPacketPermitted && liveAttempt) {
    steps.push(step(order += 1, {
      command:
        `npx agenticloop task abandon-attempt ${id} --attempt ${liveAttempt.attemptId} ` +
        '--reason <text> --authority <kind:reference>',
      writes: [`.agenticloop/handoffs/attempts/${id}/`],
      commitRequired: true,
      gate: 'worktree.clean_gate.failed',
    }));
  }

  steps.push(step(order += 1, {
    command: `npx agenticloop task prepare-dispatch ${id} ${hostArgument}--role engineer --output <packet.json> --json`,
    writes: ['<packet.json>'],
    commitRequired: false,
    gate: 'dispatch.packet.invalid',
  }));

  // Role start is a carrier mutation. For the files backend, the canonical
  // command is `task role-start` which atomically combines the in-progress
  // transition, dispatch consumption, and check-evidence initialization.
  // For GitHub, `task-body transition` plus `task check-evidence-init` are
  // used independently.
  if (backend === 'files') {
    steps.push(step(order += 1, {
      command:
        `npx agenticloop task role-start ${id} ` +
        '--packet <packet.json> --check-evidence-output <checks.json> --json',
      writes: [
        `.agenticloop/tasks/${id}.md`,
        `.agenticloop/handoffs/dispatch/${id}/`,
        `<checks.json>`,
      ],
      commitRequired: true,
      reason:
        'role start mutates the carrier, writes a dispatch consumption record, and initializes check evidence; commit all before the evidence chain reads them from Git',
      gate: 'dispatch.packet.stale',
    }));
  } else {
    steps.push(step(order += 1, {
      command:
        `npx agenticloop task status ${id} in-progress --expect-digest <current-carrier-digest> ` +
        '--dispatch-packet <packet.json> --json',
      writes: [
        `.agenticloop/tasks/${id}.md`,
        `.agenticloop/handoffs/dispatch/${id}/`,
      ],
      commitRequired: true,
      reason:
        'role start mutates the carrier and writes a dispatch consumption record; commit both before the ' +
        'evidence chain reads them from Git, and mint no further packet against the pre-start digest',
      gate: 'dispatch.packet.stale',
    }));
  }

  if (backend === 'files') {
    steps.push(step(order += 1, {
      command:
        `npx agenticloop task evidence ${id} --class implementation_artifact_evidence ` +
        '--expect-digest <post-start-carrier-digest> --product-head <commit> --json',
      writes: [
        `.agenticloop/tasks/${id}.md`,
        `.agenticloop/handoffs/task-mutations/${id}/`,
      ],
      commitRequired: true,
      gate: 'verification.context.stale',
    }));
  }

  return {
    steps: Object.freeze(steps),
    commitCount: steps.filter(item => item.commitRequired).length,
  };
}

/**
 * Render the sequence for human output, including the commits it forces.
 *
 * @param {{ steps: object[], commitCount: number }} sequence
 * @returns {string[]}
 */
export function renderHandoffSequence(sequence) {
  const lines = [
    `  next ordered sequence (${sequence.steps.length} steps, ${sequence.commitCount} commit${sequence.commitCount === 1 ? '' : 's'} required):`,
  ];
  for (const item of sequence.steps) {
    lines.push(`    ${item.order}. ${item.command}`);
    if (item.commitRequired) {
      lines.push(`       commit ${item.writes.join(', ')} before the next step (${item.commitReason})`);
    }
  }
  return lines;
}
