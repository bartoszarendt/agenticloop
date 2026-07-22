import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { init } from '../src/init.js';

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-stop-contract-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const STOP_ROUTE = 'If and only if it equals `stop` (case-insensitive), immediately follow';

describe('Agentic Loop stop contract', () => {
  it('routes an exact stop argument before activation and leaves other stop phrases as normal input', () => {
    const start = readFileSync(new URL('../commands/start.md', import.meta.url), 'utf-8');

    assert.ok(start.includes(STOP_ROUTE));
    assert.ok(start.includes('`agenticloop/commands/stop.md` and return.'));
    assert.ok(start.includes('`stop now`, `stop-gap fix`'));
    assert.ok(start.indexOf(STOP_ROUTE) < start.indexOf('Read `.agenticloop/project.md` first.'));
    assert.ok(!start.includes('equals `exit`'));
  });

  it('installs the stop contract and routes every generated public activation surface', async () => {
    const target = mkdtempSync(join(tmpDir, 'target-'));
    const result = await init({ target, adapter: 'all' });
    assert.deepEqual(result.errors, []);

    assert.ok(existsSync(join(target, 'agenticloop', 'commands', 'stop.md')));
    const stop = readFileSync(join(target, 'agenticloop', 'commands', 'stop.md'), 'utf-8');
    assert.match(stop, /current-conversation deactivation/);
    assert.match(stop, /Do not accept, close, merge, commit, push/);
    assert.match(stop, /A voluntary stop is not `blocked` or `needs_context`/);

    const surfaces = [
      '.opencode/commands/agenticloop.md',
      '.claude/commands/agenticloop.md',
      '.claude/skills/agenticloop/SKILL.md',
      '.agents/skills/agenticloop/SKILL.md',
      '.github/skills/agenticloop/SKILL.md',
      '.cursor/skills/agenticloop/SKILL.md',
    ];
    for (const relPath of surfaces) {
      const text = readFileSync(join(target, relPath), 'utf-8');
      assert.ok(text.includes(STOP_ROUTE), `${relPath} should retain exact stop routing`);
      assert.ok(text.includes('`agenticloop/commands/stop.md` and return.'), `${relPath} should reference canonical stop contract`);
    }

    assert.ok(existsSync(join(target, '.agents', 'skills', 'agenticloop', 'SKILL.md')));
    assert.equal(existsSync(join(target, '.agents', 'skills', 'agenticloop-stop')), false);
  });
});
