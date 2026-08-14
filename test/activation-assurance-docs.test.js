import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('activation-assurance documentation', () => {
  it('has no active v5-current dispatch claim', () => {
    const methodology = source('AGENTIC_LOOP.md');
    assert.match(methodology, /Dispatch packet schema version 6 is current/);
    assert.doesNotMatch(methodology, /Dispatch packet schema version 5 is current/i);
  });

  it('activates existing scaffold tasks rather than requiring replacement', () => {
    const cli = source('docs/cli-reference.md');
    const registry = source('src/cli-registry.js');
    const taskCli = source('src/task-cli.js');
    assert.match(cli, /activate the existing task with\s+`npx agenticloop activate <task-id>`/);
    assert.doesNotMatch(cli, /use a fresh activation-bound task\s+unless a separately authorized conversion is implemented/i);
    assert.doesNotMatch(registry, /cannot authorize dispatch without a current valid host-signed activation binding/i);
    assert.match(registry, /activate the existing task with agenticloop activate/);
    assert.doesNotMatch(taskCli, /obtain a fresh task-bound capture from a supported host adapter/i);
  });

  it('documents observed plugin-free returns and narrow legacy exceptions', () => {
    const cli = source('docs/cli-reference.md');
    assert.match(cli, /plugin-free operation[\s\S]*`operator_confirmed`[\s\S]*`session_reported`/);
    assert.match(cli, /never hides revoked,[\s\S]*cryptographically invalid evidence/);
    assert.match(cli, /protected host integration[\s\S]*`host_signed`[\s\S]*`host_receipt`/);
  });

  it('describes observed current return evidence rather than a capability ceiling', () => {
    const closeout = source('src/closeout.js');
    assert.doesNotMatch(closeout, /highest grade this target could possibly have produced/i);
    assert.match(closeout, /current work-unit-bound verification observation/);
  });

  it('keeps GitHub returns on the external producer and public verifier path', () => {
    const github = source('backends/github.md');
    assert.match(github, /configured GitHub host\/role producer[\s\S]*raw `agenticloop\.role-return`[\s\S]*authoritative GitHub issue\/PR facts/);
    assert.match(github, /`task verify-return` imports and revalidates the raw\s+return and current GitHub facts/);
    assert.match(github, /Files-only `task check-evidence-\*` and `task\s+prepare-return` commands are not GitHub producer commands/);
    assert.doesNotMatch(github, /same public artifact sequence as files/);
    assert.doesNotMatch(github, /`task check-evidence-init`\/`task check-evidence-update`, `task prepare-return`/);
  });

  it('documents protected execution-receipt verification and replay semantics', () => {
    const cli = source('docs/cli-reference.md');
    assert.match(cli, /--producer-receipt producer-receipt\.json --execution-receipt execution-receipt\.json/);
    assert.match(cli, /`host_receipt` assurance[\s\S]*producer receipt and protected host-issued execution receipt/);
    assert.match(cli, /`session_reported`[\s\S]*reduced\/unverified assurance/);
    assert.match(cli, /producer-receipt and execution-receipt\s+selectors are target-relative and confined/);
    assert.match(cli, /external protected host boundary[\s\S]*not[\s\S]*CLI-held signing material or self-attestation/);
    assert.match(cli, /replay binding is prepared\s+and committed[\s\S]*revalidated as current on\s+later verification/);
  });

  it('distinguishes standard files returns from hardened receipt requirements', () => {
    const files = source('backends/files.md');
    assert.match(files, /Standard mode accepts an explicitly `session_reported`, freshly revalidated raw[\s\S]*reduced\/unverified assurance/);
    assert.match(files, /Hardened mode, or any effective[\s\S]*`host_receipt` requirement[\s\S]*packet-bound Ed25519\s+producer receipt and protected host-issued execution receipt/);
    assert.match(files, /Trust-registry,\s+binding, replay, invalid, missing[\s\S]*caller-edited required\s+receipts fail closed/);
  });
});
