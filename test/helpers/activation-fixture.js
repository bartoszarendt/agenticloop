/**
 * Shared activation-grant test fixtures: canonical pure grant/binding records
 * plus the CLI-facing scaffold fixture and dispatch helpers. Extracted from
 * the original activation-grant test suite so the split files share one source
 * of truth for what a valid grant, binding, and scaffold project look like.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLI_OPERATOR_PRODUCER_ID,
  OPERATOR_CONFIRMATION_PHRASE,
  createActivationGrant,
  createTaskActivationBinding,
} from '../../src/activation-grant.js';
import { taskContractDigest } from '../../src/task-contract-baseline.js';
import { createDispatchFixture, git, sha256 } from './dispatch-fixture.js';
import { runCliInProcess, scriptedPromptFactory } from './run-cli.js';

export const REPOSITORY = 'file:/tmp/fixture-repo';

export function grantFor(overrides = {}) {
  return createActivationGrant({
    repositoryIdentity: REPOSITORY,
    backend: 'files',
    scope: { type: 'exact_tasks', taskIds: ['T-016', 'T-017'] },
    assurance: 'operator_confirmed',
    producer: { id: CLI_OPERATOR_PRODUCER_ID, channel: 'cli_interactive_confirmation' },
    evidence: {
      confirmedAt: new Date().toISOString(),
      confirmationPhrase: OPERATOR_CONFIRMATION_PHRASE,
      channel: 'cli_interactive_confirmation',
      operatorKeyId: 'operator-0123456789abcdef',
      scopeSummaryDigest: sha256('scope summary'),
    },
    ...overrides,
  });
}

export const CONTRACT_DIGEST = `sha256:v1:${'a'.repeat(64)}`;

export function bindingFor(grant, overrides = {}) {
  return createTaskActivationBinding({
    grant,
    backend: 'files',
    taskId: 'T-016',
    carrier: '.agenticloop/tasks/T-016.md',
    taskContractDigest: CONTRACT_DIGEST,
    derivation: 'direct_operator_confirmation',
    ...overrides,
  });
}

/**
 * Turn a host-signed fixture into a plain scaffold project: the task keeps its
 * id, body, history, and decomposition, and simply loses its legacy activation
 * frontmatter. This is exactly the "existing scaffold/decomposed project" case.
 */
export async function scaffoldFixture(temp, name) {
  const fixture = await createDispatchFixture(temp, name, { scaffold: true });
  // The plugin-free path is the point of this fixture: no pinned host adapter
  // exists, so every command runs against an empty operator trust root.
  fixture.operatorTrustRoot = mkdtempSync(join(temp, `${name}-empty-trust-`));
  fixture.operatorActivationRoot = mkdtempSync(join(temp, `${name}-operator-activation-`));
  fixture.contractDigest = taskContractDigest(readFileSync(fixture.taskPath, 'utf8')).digest;
  return fixture;
}

export async function correctContract(fixture, priorDigest, reason) {
  const corrected = await runCliInProcess([
    'task', 'authorize-correction', 'T-001',
    '--expect-prior-digest', priorDigest,
    '--reason', reason,
    '--authority', 'task:T-001',
    '--actor', 'Agentic Loop Test',
    '--target', fixture.root,
  ]);
  assert.equal(corrected.status, 0, corrected.stderr);
  git(fixture.root, ['add', '.agenticloop/task-contract-history']);
  git(fixture.root, ['commit', '-m', `authorize contract correction\n\nTask: T-001\nAgent: maintainer`]);
}

export function interactiveOptions(fixture, answers = [OPERATOR_CONFIRMATION_PHRASE]) {
  return {
    isTTY: true,
    stdinIsTTY: true,
    ci: false,
    promptFactory: scriptedPromptFactory(answers),
    operatorTrustRoot: fixture.operatorTrustRoot,
    operatorActivationRoot: fixture.operatorActivationRoot,
  };
}

export function writeSecondTask(fixture, taskId) {
  const body = readFileSync(fixture.taskPath, 'utf8').replaceAll('T-001', taskId);
  writeFileSync(join(fixture.root, '.agenticloop', 'tasks', `${taskId}.md`), body, 'utf8');
  git(fixture.root, ['add', `.agenticloop/tasks/${taskId}.md`]);
  git(fixture.root, ['commit', '-m', `record ${taskId}\n\nTask: ${taskId}\nAgent: maintainer`]);
}

/** Write the fixture's own dispatch input beside the target. */
export function writeDispatchInput(fixture) {
  writeFileSync(
    join(fixture.root, 'dispatch-input.json'),
    JSON.stringify({
      readiness: fixture.readiness,
      decomposition: fixture.decomposition,
      assignment: fixture.assignment,
    }, null, 2),
    'utf8'
  );
}

/** Run the real `task prepare-dispatch` command against the fixture. */
export function runPrepareDispatch(fixture, extraArgs = []) {
  writeDispatchInput(fixture);
  return runCliInProcess([
    'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json', '--target', fixture.root, ...extraArgs,
  ], {
    operatorTrustRoot: fixture.operatorTrustRoot,
    operatorActivationRoot: fixture.operatorActivationRoot,
  });
}

/** Run `task prepare-dispatch` and return the emitted packet. */
export async function prepareThroughCli(fixture) {
  const result = await runPrepareDispatch(fixture);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
