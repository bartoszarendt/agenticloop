/**
 * A fresh checkout is not a different commit.
 *
 * Raw checkout bytes must not define committed identity, and provisioning LF
 * attributes is a mitigation rather than the fix. The mitigation was
 * provisioned. A later field run then cut a fresh worktree and `validate`
 * reported eight errors against it - four line-ending-sensitive
 * methodology-text mismatches and four canonical-role-body mismatches - which
 * was repaired by hand before the lane could be used. The same commit,
 * validating differently depending on how a checkout materialized it.
 *
 * Line endings are a property of a checkout, not of a commit. These cases
 * materialize a target the way a Windows checkout with `core.autocrlf=true`
 * would, and require the identical verdict.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-identity-portability-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

/** Text a checkout filter would convert; binary and lock files are left alone. */
const CONVERTED_EXTENSIONS = ['.md', '.toml', '.json', '.jsonc', '.yml', '.yaml', '.txt'];

/** Rewrite every text file below `root` the way a CRLF checkout materializes it. */
function materializeAsCrlfCheckout(root) {
  let converted = 0;
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      if (name === '.git') continue;
      const full = join(directory, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!CONVERTED_EXTENSIONS.some(extension => name.endsWith(extension))) continue;
      const content = readFileSync(full, 'utf8');
      if (!content.includes('\n')) continue;
      writeFileSync(full, content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
      converted += 1;
    }
  };
  walk(root);
  return converted;
}

async function initializedTarget(name, adapter) {
  const target = mkdtempSync(join(temp, `${name}-`));
  const initialized = await runCliInProcess(['init', '--adapter', adapter, '--target', target]);
  assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
  return target;
}

describe('validate reaches the same verdict on any checkout', () => {
  for (const adapter of ['opencode', 'codex', 'claude-code']) {
    it(`passes a CRLF-materialized ${adapter} target with no manual repair`, async () => {
      const target = await initializedTarget(`crlf-${adapter}`, adapter);
      const before = await runCliInProcess(['validate', '--target', target]);
      assert.equal(before.status, 0, `${before.stdout}\n${before.stderr}`);

      const converted = materializeAsCrlfCheckout(target);
      assert.ok(converted > 0, 'the fixture must actually convert something to be meaningful');

      const after = await runCliInProcess(['validate', '--target', target]);
      assert.equal(
        after.status,
        0,
        `a checkout that materialized the same commit with CRLF must validate identically:\n${after.stdout}\n${after.stderr}`
      );
    });
  }

  it('still reports a real content difference, so the normalization is not a blanket pass', async () => {
    const target = await initializedTarget('crlf-negative', 'opencode');
    materializeAsCrlfCheckout(target);
    const agent = join(target, '.opencode', 'agents', 'engineer.md');
    const body = readFileSync(agent, 'utf8');
    writeFileSync(agent, body.replace(/Follow [^\r\n]*as the canonical role contract\./, 'Follow nothing at all.'), 'utf8');

    const result = await runCliInProcess(['validate', '--target', target]);
    assert.equal(result.status, 1, 'a genuine body change is still a failure');
  });
});
