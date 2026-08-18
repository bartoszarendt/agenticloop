/**
 * A public failure must still be diagnosable.
 *
 * The field run's terminal failure was a real protocol deadlock hidden behind a
 * diagnostic that carried no information at all. `task prepare-return --debug`
 * printed:
 *
 *     code:            cli.operational
 *     message:         The command could not complete because required
 *                      operational context is unavailable.
 *     debugReference:  null
 *     requiredContext: []
 *
 * The actual cause - `TypeError: invalid role return: implementation-ready role
 * return requires productChangedPaths derived from Git` - existed the whole
 * time. It was erased at the command boundary, `debugReference` was hardcoded
 * to `null`, and because the command caught its own error it never reached the
 * top-level handler where `--debug` prints a stack. There was no supported path
 * by which the role, the operator, or a support channel could learn the cause.
 *
 * These cases pin the three things that closes: a real reference on every
 * envelope, `--debug` honoured inside the command, and typed producer errors
 * that carry their own public sentence instead of being generalized away.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { commandFailure } from '../src/public-result.js';
import { debugReferenceFor, runWithDebugTrace } from '../src/debug-trace.js';
import { PublicCommandError } from '../src/public-error.js';
import { createRoleReturn } from '../src/dispatch-envelope.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-diagnosable-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

describe('every command-boundary failure carries a support handle', () => {
  it('emits a real debugReference for an untyped producer error', () => {
    const result = commandFailure('task prepare-return', new TypeError('invalid role return: something internal'));
    assert.match(result.debugReference, /^debug:sha256:[0-9a-f]{64}$/,
      'the field envelope hardcoded null here, leaving no way to request the cause');
  });

  it('derives the reference from the command and the internal message, and only those', () => {
    const error = new TypeError('invalid role return: something internal');
    assert.equal(
      commandFailure('task prepare-return', error).debugReference,
      debugReferenceFor('task prepare-return', error),
      'the same failure on the same command must produce a quotable, stable handle'
    );
    assert.notEqual(
      commandFailure('task prepare-return', error).debugReference,
      commandFailure('task verify-return', error).debugReference
    );
    assert.notEqual(
      commandFailure('task prepare-return', error).debugReference,
      commandFailure('task prepare-return', new TypeError('a different internal cause')).debugReference
    );
  });

  it('preserves requiredContext instead of flattening it to an empty list', () => {
    const result = commandFailure('task prepare-return', new PublicCommandError('needs context', {
      requiredContext: ['the exact verification context required by the command'],
    }));
    assert.deepEqual(result.requiredContext, ['the exact verification context required by the command']);
  });
});

describe('--debug reaches failures a command catches itself', () => {
  it('writes the real stack to stderr when the debug context is active', () => {
    const lines = [];
    const io = { err: line => lines.push(String(line ?? '')) };
    const error = new TypeError('invalid role return: implementation-ready role return requires productChangedPaths');
    const result = runWithDebugTrace({ debug: true, io }, () => commandFailure('task prepare-return', error));
    const written = lines.join('\n');
    assert.match(written, /invalid role return: implementation-ready role return requires productChangedPaths/);
    assert.match(written, new RegExp(result.debugReference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('stays silent without the debug context, so the public envelope is unchanged', () => {
    const lines = [];
    const io = { err: line => lines.push(String(line ?? '')) };
    runWithDebugTrace({ debug: false, io }, () => commandFailure('task prepare-return', new TypeError('internal')));
    assert.deepEqual(lines, []);
  });

  it('honours AGENTICLOOP_DEBUG=1 through the real CLI', async () => {
    const root = mkdtempSync(join(temp, 'debug-env-'));
    createTaskProjectFixture(root);
    const result = await runCliInProcess([
      'task', 'prepare-return', 'T-404', '--packet', 'missing.json',
      '--check-evidence', 'missing.json', '--outcome', 'implementation_ready_for_review',
      '--output', '.agenticloop/tmp/out.json', '--json', '--target', root,
    ], { env: { ...process.env, AGENTICLOOP_DEBUG: '1' } });
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.match(envelope.debugReference, /^debug:sha256:[0-9a-f]{64}$/);
    assert.match(result.stderr, /debug:sha256:[0-9a-f]{64}/,
      '--debug printed zero additional bytes in the field; it must print the cause now');
  });
});

describe('producer paths carry typed errors rather than plain ones', () => {
  it('types the exact refusal that ended the field run and keeps its sentence public', () => {
    // A construction refusal is a fact about the caller's own evidence. Thrown
    // as a bare TypeError it reached a boundary obliged to erase its message.
    assert.throws(
      () => createRoleReturn({ producerRole: 'engineer' }),
      error => {
        assert.ok(error instanceof PublicCommandError, 'the producer must throw a typed public error');
        assert.equal(error.code, 'role_return.invalid');
        assert.match(error.publicMessage, /^invalid role return: /);
        assert.equal(error.publicMessage, error.message, 'the public sentence names the real cause');
        assert.ok(error.safeRepair, 'a typed refusal carries its own safe repair');
        return true;
      }
    );
  });

  it('surfaces that typed message through the command boundary instead of the generic sentence', () => {
    let thrown;
    try { createRoleReturn({ producerRole: 'engineer' }); } catch (error) { thrown = error; }
    const result = commandFailure('task prepare-return', thrown);
    assert.equal(result.diagnostics[0].code, 'role_return.invalid');
    assert.match(result.errors.join('\n'), /invalid role return: /);
    assert.doesNotMatch(
      result.errors.join('\n'),
      /required operational context is unavailable/,
      'this is the sentence the field run read thirteen times for a cause that names itself'
    );
  });
});
