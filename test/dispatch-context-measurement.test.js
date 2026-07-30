import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../src/canonical-json.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'measure-dispatch-context.mjs');
let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-context-measure-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('dispatch acting-context measurement', () => {
  it('reports deterministic exact UTF-8 component bytes and rejects duplicates', () => {
    const packet = join(temp, 'packet.json');
    const role = join(temp, 'role.md');
    const activation = join(temp, 'activation.md');
    const reference = join(temp, 'reference.md');
    const packetValue = { z: 1, a: 'żółć' };
    writeFileSync(packet, JSON.stringify(packetValue, null, 2), 'utf8');
    writeFileSync(role, 'role\n', 'utf8');
    writeFileSync(activation, 'activation\n', 'utf8');
    writeFileSync(reference, 'reference\n', 'utf8');
    const args = [
      '--packet', packet,
      '--role-wrapper', role,
      '--activation-wrapper', activation,
      '--reference', reference,
    ];
    const first = run(args);
    const second = run(args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    const result = JSON.parse(first.stdout);
    assert.equal(result.packetSerialization, 'canonicalJson');
    assert.deepEqual(result.components.map(item => item.kind), [
      'canonical_packet',
      'generated_role_wrapper',
      'generated_activation_wrapper',
      'canonical_reference',
    ]);
    const expected = [
      Buffer.byteLength(canonicalJson(packetValue), 'utf8'),
      Buffer.byteLength('role\n', 'utf8'),
      Buffer.byteLength('activation\n', 'utf8'),
      Buffer.byteLength('reference\n', 'utf8'),
    ];
    assert.deepEqual(result.components.map(item => item.bytes), expected);
    assert.equal(result.totalBytes, expected.reduce((sum, value) => sum + value, 0));

    const duplicate = run([...args, '--reference', role]);
    assert.equal(duplicate.status, 2);
    assert.match(duplicate.stderr, /same context component/);
  });
});
