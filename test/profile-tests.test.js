import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseArgv, selectProfileFiles } from '../scripts/profile-tests.js';

const SCRIPT = join(process.cwd(), 'scripts', 'profile-tests.js');

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('profile test selection', () => {
  it('rejects a stale manifest before default, group, or directory discovery can execute', () => {
    const staleManifest = () => { throw new Error('test group manifest mismatch: unclassified files'); };
    for (const opts of [
      parseArgv([]),
      parseArgv(['--group', 'fast']),
      parseArgv(['--dir', 'path-that-must-not-be-discovered']),
    ]) {
      assert.throws(() => selectProfileFiles(opts, staleManifest), /test group manifest mismatch/);
    }
  });

  it('accepts the explicit fast group and retains --match, --jobs, and JSON output', () => {
    const json = join('.agenticloop', 'tmp', `profile-tests-${process.pid}-${Date.now()}.json`);
    try {
      const result = run('--group', 'fast', '--match', '(?!)', '--jobs', '2', '--json', json);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Profiling 0 test files/);
      assert.equal(JSON.parse(readFileSync(join(process.cwd(), json), 'utf8')).jobs, 2);
    } finally {
      rmSync(join(process.cwd(), json), { force: true });
    }
  });

  it('rejects an invalid group with usage', () => {
    const result = run('--group', 'slow');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--group must be one of/);
    assert.match(result.stderr, /Usage:/);
  });

  it('rejects an unknown option with usage and exit code 2', () => {
    const result = run('--wat');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown option: --wat/);
    assert.match(result.stderr, /Usage:/);
  });

  it('returns concise usage errors for invalid and missing --match values', () => {
    const invalid = run('--match', '[');
    const missing = run('--match');

    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /--match must be a valid regular expression/);
    assert.match(invalid.stderr, /Usage:/);
    assert.doesNotMatch(invalid.stderr, /SyntaxError|\n\s+at\s/);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--match requires a regular expression/);
  });
});
