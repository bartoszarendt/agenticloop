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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { commandFailure } from '../src/public-result.js';
import { debugReferenceFor, runWithDebugTrace } from '../src/debug-trace.js';
import { PublicCommandError } from '../src/public-error.js';
import { createRoleReturn } from '../src/dispatch-envelope.js';
import { renderPackageVersion } from '../src/build-identity.js';
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

describe('a usage error stays a usage error, and --debug adds something', () => {
  // Corrected mid-run by `3b655a8` and kept as a guard, because the field met
  // it: `task commit-message --class evidence` surfaced as
  // `[cli.unexpected] Validation or evaluation did not complete` wrapping a
  // `CliUsageError`, and rerunning with `--debug` returned the identical debug
  // reference and no additional detail - contradicting its own repair hint.
  async function refuseInvalidClass(root, options = {}) {
    return runCliInProcess([
      'task', 'commit-message', 'T-001', '--class', 'evidence',
      '--subject', 'record the implementation artifact',
      '--output', '.agenticloop/tmp/message.txt', '--json', '--target', root,
    ], options);
  }

  it('types an invalid --class as usage rather than an internal failure', async () => {
    const root = mkdtempSync(join(temp, 'usage-typing-'));
    createTaskProjectFixture(root);
    const result = await refuseInvalidClass(root);
    assert.equal(result.status, 2, 'a rejected enum is a usage error, not a failed evaluation');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.diagnostics[0].code, 'cli.usage');
    assert.doesNotMatch(
      envelope.errors.join('\n'),
      /Validation or evaluation did not complete/,
      'this is the sentence a plain invalid-enum refusal was rendered as in the field'
    );
    assert.match(envelope.errors.join('\n'), /Invalid --class value 'evidence'/);
    assert.match(envelope.errors.join('\n'), /Use: product_implementation, /,
      'the refusal names the accepted values rather than a debug reference');
  });

  it('gives --debug something to add beyond the reference it already printed', async () => {
    const root = mkdtempSync(join(temp, 'usage-debug-'));
    createTaskProjectFixture(root);
    const plain = await refuseInvalidClass(root);
    const debugged = await refuseInvalidClass(root, { env: { ...process.env, AGENTICLOOP_DEBUG: '1' } });

    assert.equal(
      JSON.parse(debugged.stdout).debugReference,
      JSON.parse(plain.stdout).debugReference,
      'the reference is a stable handle for the same failure on the same command'
    );
    assert.ok(
      debugged.stderr.length > plain.stderr.length,
      'the repair hint says to rerun once with --debug; it must then print more than it did without it'
    );
    assert.match(debugged.stderr, /Invalid --class value 'evidence'/);
  });
});

describe('a field record can name the build that produced it', () => {
  it('carries a build marker beside the released version', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const result = await runCliInProcess(['--version']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`^agenticloop ${pkg.version.replaceAll('.', '\.')} `));
    assert.match(
      result.stdout,
      /\(build (git:[0-9a-f]{12}(\+dirty)?|src:[0-9a-f]{12})\)/,
      'the package installs from a Git ref, so the version string alone cannot name the code that ran'
    );
  });

  it('changes with the source it describes', () => {
    assert.notEqual(renderPackageVersion('0.4.3'), '0.4.3');
    assert.match(renderPackageVersion('0.4.3'), /^0\.4\.3 \(build /);
  });
});
