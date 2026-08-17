/**
 * One renderer for every activation refusal.
 *
 * C12-F9 recorded that activation was *not* the dominant source of measured
 * churn - it was one refusal among hundreds - but that it still mattered more
 * than its count, because it is the only step an operator must perform
 * personally. What the field session met at that step was a set of independently
 * authored strings that all said the same narrow thing: activate this one task.
 *
 * `agenticloop activate` has accepted an explicit task list and a canonical
 * `--work-unit` since before the field run. The operator was never told. So a
 * milestone of eight ready tasks read as eight separate interactive
 * confirmations, and the one command that would have covered them was invisible
 * at exactly the moment it was needed.
 *
 * This module renders the whole offer once, from whatever scope facts the
 * refusal site actually has. Sites that know only the task still get the exact
 * task command; sites that know the ready set or the work unit get those too.
 *
 * What it does not do, and must not: it never weakens the assurance boundary it
 * is advertising. Every command it prints is the interactive operator path.
 * There is no `--yes`, no batch flag that skips confirmation, and no suggestion
 * that a model can produce this evidence. The point of surfacing the batch
 * options is to reduce the number of times a human is interrupted, never to
 * reduce what a human has to see.
 */

/** The canonical activation command family. */
const ACTIVATE = 'npx agenticloop activate';

/** The lifetime facts an operator should see before confirming. */
export const ACTIVATION_LIFETIME_NOTE =
  'The confirmation prints the exact tasks, contract digests, work unit, and the ' +
  'grant lifetime before asking; the default lifetime applies unless ' +
  '--expires-in-hours requests another.';

/**
 * Build the structured activation repair for one refusal.
 *
 * @param {{
 *   taskId?: string|null,
 *   readyTaskIds?: string[]|null,
 *   workUnitId?: string|null,
 *   detail?: string|null,
 * }} facts
 */
export function activationRepairPlan(facts = {}) {
  const taskId = typeof facts.taskId === 'string' && facts.taskId.trim() ? facts.taskId.trim() : null;
  const workUnitId = typeof facts.workUnitId === 'string' && facts.workUnitId.trim()
    ? facts.workUnitId.trim()
    : null;
  const readyTaskIds = Array.isArray(facts.readyTaskIds)
    ? [...new Set(facts.readyTaskIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))].sort()
    : [];

  const options = [];
  options.push({
    scope: 'exact_task',
    when: 'authorizing only this task',
    command: `${ACTIVATE} ${taskId ?? '<task-id>'}`,
  });
  // A list is only worth offering when there is genuinely more than one ready
  // task to name. Suggesting a "batch" of one is noise.
  if (readyTaskIds.length > 1) {
    options.push({
      scope: 'task_list',
      when: 'authorizing the current ready set in one confirmation',
      command: `${ACTIVATE} ${readyTaskIds.join(' ')}`,
    });
  }
  // A durable grouping identity is offered only when one exists. A synthesized
  // `work-unit:<task-id>` is not a milestone, and offering it as one would
  // teach the operator a scope that does not mean what it appears to mean.
  if (workUnitId && !isSynthesizedPerTaskWorkUnit(workUnitId, taskId)) {
    options.push({
      scope: 'canonical_work_unit',
      when: 'authorizing the whole work unit as it is currently bound',
      command: `${ACTIVATE} --work-unit ${workUnitId}`,
    });
  }

  return Object.freeze({
    detail: typeof facts.detail === 'string' && facts.detail ? facts.detail : null,
    // Stated at every site, because it is the property that makes this evidence
    // worth anything: the operator runs it, not the agent.
    boundary:
      'Run it yourself in an interactive terminal outside the agent session, on the machine that owns the checkout. ' +
      'There is deliberately no --yes flag: that would let an agent mint this assurance grade silently.',
    lifetime: ACTIVATION_LIFETIME_NOTE,
    // A list or work-unit authorization covers exactly the scope it was bound
    // to. Undeclared later additions are not covered and need a new one.
    scopeNote:
      'A task-list or work-unit authorization covers exactly the scope bound at confirmation; ' +
      'tasks added afterwards are not covered and need a new confirmation.',
    options: Object.freeze(options.map(option => Object.freeze(option))),
  });
}

/**
 * Whether a work-unit identity is just this task wearing a milestone's clothes.
 *
 * The decomposition fallback produces `work-unit:<task-id>` when a task has no
 * durable grouping. Offering that as a "work unit" option is worse than
 * offering nothing: it is identical in effect to the exact-task command while
 * implying broader coverage.
 */
function isSynthesizedPerTaskWorkUnit(workUnitId, taskId) {
  if (!taskId) return false;
  return workUnitId === `work-unit:${taskId}` || workUnitId === taskId;
}

/**
 * Render one activation repair plan as a single-line `repairHint`.
 *
 * `repairHint` is contractually an *exact executable command*, not prose - the
 * preflight suite asserts it has no trailing period and equals the command
 * verbatim. That contract is right and is kept: with one applicable scope the
 * render is exactly that command and nothing else.
 *
 * The batch and work-unit options are appended only when they genuinely exist,
 * still command-led, so a milestone refusal shows the one command that covers
 * the ready set without turning the common single-task case into a paragraph.
 * The boundary, scope, and lifetime notes stay on the plan object for
 * structured consumers and for the interactive confirmation, which is where an
 * operator actually needs to read them.
 */
export function renderActivationRepair(facts = {}) {
  const plan = facts?.options ? facts : activationRepairPlan(facts);
  const [primary, ...rest] = plan.options;
  if (rest.length === 0) return primary.command;
  return [
    primary.command,
    ...rest.map(option => `or, when ${option.when}: ${option.command}`),
  ].join('; ');
}
