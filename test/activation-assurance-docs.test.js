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
});
