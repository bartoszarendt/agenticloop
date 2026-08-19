/**
 * A producer that refuses its caller's evidence must say so publicly.
 *
 * `createRoleReturn` was typed after the field run spent thirteen
 * `prepare-return` invocations reading "required operational context is
 * unavailable" for a refusal that named its own cause. That fix was one site.
 * The same erasure was still reachable from every other producer a command
 * calls directly and hands its throw to the failure boundary:
 *
 *   - `activate`             -> createActivationGrant, createTaskActivationBinding
 *   - `activation revoke`    -> createActivationRevocation
 *   - `task status`, `task-body` -> createDispatchConsumption
 *
 * Each of those raises a caller-evidence refusal. Untyped, `commandFailure`
 * replaces the sentence with `OPERATIONAL_FAILURE_MESSAGE`, and an uncaught one
 * is rendered `cli.unexpected` - "validation or evaluation did not complete" -
 * which reads as a toolkit bug for a precise, actionable refusal.
 *
 * These cases pin both halves: every one of those producers throws the shared
 * typed refusal, and the producer functions themselves contain no bare
 * `TypeError` a future edit could reintroduce.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PublicCommandError, ProducerRefusalError, OPERATIONAL_FAILURE_MESSAGE } from '../src/public-error.js';
import { commandFailure } from '../src/public-result.js';
import { repairPolicyFor } from '../src/repair-policy.js';
import {
  createActivationGrant,
  createActivationRevocation,
  createTaskActivationBinding,
} from '../src/activation-grant.js';
import { createDispatchConsumption } from '../src/handoff-consumption.js';
import { createRoleReturn } from '../src/dispatch-envelope.js';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Every producer whose refusal can reach a public command surface, with the
 * command that reaches it and one refusal that is a fact about caller evidence.
 */
const REACHABLE_PRODUCERS = Object.freeze([
  {
    name: 'createActivationGrant',
    command: 'activate',
    refuse: () => createActivationGrant({ assurance: 'scaffold', scope: { type: 'exact_tasks', taskIds: ['T-1'] } }),
    expectedSentence: /assurance must be operator_confirmed or host_signed/,
  },
  {
    name: 'createTaskActivationBinding',
    command: 'activate',
    refuse: () => createTaskActivationBinding({ backend: 'files', taskId: 'T-1' }),
    expectedSentence: /requires its authorizing grant/,
  },
  {
    name: 'createActivationRevocation',
    command: 'activation revoke',
    refuse: () => createActivationRevocation({ reason: 'operator revocation' }),
    expectedSentence: /requires the grant it revokes/,
  },
  {
    name: 'createDispatchConsumption',
    command: 'task status',
    refuse: () => createDispatchConsumption({ backend: 'files', taskId: 'T-1', recognition: { recognized: false } }),
    expectedSentence: /recognized prepared-dispatch role-start verdict/,
  },
  {
    name: 'createRoleReturn',
    command: 'task prepare-return',
    refuse: () => createRoleReturn({ producerRole: 'engineer' }),
    expectedSentence: /^invalid role return: /,
  },
]);

describe('every command-reachable producer refuses with a typed public error', () => {
  for (const producer of REACHABLE_PRODUCERS) {
    it(`${producer.name} names its own cause`, () => {
      assert.throws(producer.refuse, error => {
        assert.ok(error instanceof ProducerRefusalError,
          `${producer.name} must raise the shared typed producer refusal`);
        assert.ok(error instanceof PublicCommandError);
        assert.match(error.message, producer.expectedSentence);
        assert.equal(error.publicMessage, error.message,
          'the public sentence is the real cause, not a generalization of it');
        assert.ok(error.safeRepair, 'a typed refusal carries its own safe repair');
        // The code must already be a repair-policy fact: a producer refusal
        // names existing evidence, it does not mint a new repair capability.
        assert.doesNotThrow(() => repairPolicyFor(error.code),
          `${producer.name} declares an unregistered diagnostic code '${error.code}'`);
        return true;
      });
    });

    it(`${producer.name} survives the command-failure boundary intact`, () => {
      let thrown;
      try { producer.refuse(); } catch (error) { thrown = error; }
      const result = commandFailure(producer.command, thrown);
      assert.equal(result.diagnostics[0].code, thrown.code);
      assert.match(result.errors.join('\n'), producer.expectedSentence);
      assert.doesNotMatch(
        result.errors.join('\n'),
        new RegExp(OPERATIONAL_FAILURE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'this is the sentence that erased the cause in the field'
      );
    });
  }
});

/**
 * Producer functions whose bodies must stay free of bare `TypeError` refusals.
 * The private normalizers are listed too: they are only ever reached through the
 * exported producer, so a bare throw inside one escapes exactly the same way.
 */
const GUARDED_PRODUCERS = Object.freeze({
  'src/activation-grant.js': [
    'createActivationGrant',
    'normalizeScope',
    'normalizeEvidence',
    'createTaskActivationBinding',
    'createActivationRevocation',
  ],
  'src/handoff-consumption.js': ['createDispatchConsumption'],
  'src/dispatch-envelope.js': ['createRoleReturn'],
});

/** The source lines of one top-level function declaration, brace-matched. */
function functionBody(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex(line =>
    line.startsWith(`function ${name}(`) || line.startsWith(`export function ${name}(`));
  assert.notEqual(start, -1, `no top-level declaration of ${name}`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  assert.ok(end < lines.length, `unterminated declaration of ${name}`);
  return lines.slice(start, end + 1);
}

describe('no command-reachable producer reintroduces an untyped refusal', () => {
  for (const [file, names] of Object.entries(GUARDED_PRODUCERS)) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const name of names) {
      it(`${file}:${name} throws no bare TypeError`, () => {
        const offending = functionBody(source, name)
          .map((line, index) => ({ line, index }))
          .filter(item => item.line.includes('throw new TypeError('));
        assert.deepEqual(
          offending.map(item => item.line.trim()),
          [],
          `${name} must raise the shared typed producer refusal instead`
        );
      });
    }
  }
});
